const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const BOTS_DIR = path.join(ROOT_DIR, 'bots-data');
const DB_FILE = path.join(ROOT_DIR, 'bots.json');

for (const dir of [PUBLIC_DIR, UPLOADS_DIR, BOTS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

// تخزين الذاكرة المؤقت للعمليات الجارية وعملاء البث المباشر للسجلات
const runningProcesses = new Map(); // botId -> { child, status, intentionalStop }
const logClients = new Map(); // botId -> Set<res>
const logHistory = new Map(); // botId -> string[]

const IGNORED_DIRS = new Set(['node_modules', '.git', '__MACOSX']);

function loadBots() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBots(bots) {
  fs.writeFileSync(DB_FILE, JSON.stringify(bots, null, 2), 'utf8');
}

function appendLog(botId, line) {
  const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const formatted = `[${timestamp}] ${line}`;

  if (!logHistory.has(botId)) {
    logHistory.set(botId, []);
  }
  const history = logHistory.get(botId);
  history.push(formatted);
  if (history.length > 500) {
    history.shift();
  }

  const clients = logClients.get(botId);
  if (clients) {
    for (const res of clients) {
      res.write(`data: ${JSON.stringify({ line: formatted })}\n\n`);
    }
  }
}

function setBotState(botId, statePatch) {
  const bots = loadBots();
  const idx = bots.findIndex((b) => b.id === botId);
  if (idx !== -1) {
    bots[idx] = { ...bots[idx], ...statePatch };
    saveBots(bots);
  }
}

// تهيئة السجل وتحديث حالة العرض الأولية دون فقدان معلومة autoStartOnBoot
(function prepareBotsOnBoot() {
  const bots = loadBots();
  let changed = false;
  for (const bot of bots) {
    if (typeof bot.autoStartOnBoot !== 'boolean') {
      bot.autoStartOnBoot = bot.status === 'running';
      changed = true;
    }
    if (bot.status !== 'stopped') {
      bot.status = 'stopped';
      changed = true;
    }
    if (!logHistory.has(bot.id)) {
      logHistory.set(bot.id, []);
    }
  }
  if (changed) {
    saveBots(bots);
  }
})();

// التحقق من أن المسار المطلوب يقع فعلياً داخل مجلد البوت ولا يخرج عنه
function resolveSafeBotFilePath(botId, relativeFilePath) {
  if (typeof relativeFilePath !== 'string' || !relativeFilePath.trim()) {
    return null;
  }

  const normalizedRel = relativeFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalizedRel.includes('\0')) {
    return null;
  }

  const botRoot = path.resolve(BOTS_DIR, botId);
  const targetPath = path.resolve(botRoot, normalizedRel);

  if (targetPath === botRoot || !targetPath.startsWith(botRoot + path.sep)) {
    return null;
  }

  return targetPath;
}

// جمع قائمة الملفات داخل مجلد البوت بشكل متكرر مع استثناء المجلدات الثقيلة/المخفية
function listBotFilesRecursive(baseDir, currentDir = baseDir, results = []) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      listBotFilesRecursive(baseDir, fullPath, results);
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      results.push(relPath);
    }
  }
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

// إيقاف عملية البوت وشجرتها الفرعية على Windows أو Linux بشكل نظيف
function killBotProcess(botId) {
  return new Promise((resolve) => {
    const entry = runningProcesses.get(botId);
    if (!entry || !entry.child) {
      runningProcesses.delete(botId);
      setBotState(botId, { status: 'stopped', pid: null, autoStartOnBoot: false });
      return resolve();
    }

    const pid = entry.child.pid;
    entry.intentionalStop = true;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      runningProcesses.delete(botId);
      setBotState(botId, { status: 'stopped', pid: null, autoStartOnBoot: false });
      resolve();
    };

    entry.child.once('exit', () => {
      setTimeout(finish, 250);
    });

    if (process.platform === 'win32' && pid) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        try {
          entry.child.kill('SIGKILL');
        } catch {}
      }
      setTimeout(finish, 600);
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          entry.child.kill('SIGKILL');
        } catch {}
      }
      setTimeout(finish, 400);
    } else {
      finish();
    }
  });
}

// حذف مجلد بأمان مع إعادة المحاولة عند وجود قفل مؤقت (EBUSY / EPERM)
async function removeDirectoryWithRetry(targetDir, maxRetries = 6, delayMs = 250) {
  if (!fs.existsSync(targetDir)) {
    return { deleted: true };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      if (!fs.existsSync(targetDir)) {
        return { deleted: true };
      }
    } catch (err) {
      const isRetryable =
        err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY');
      if (!isRetryable || attempt === maxRetries) {
        return { deleted: false, error: err };
      }
    }
    await new Promise((r) => setTimeout(r, delayMs * attempt));
  }

  return { deleted: !fs.existsSync(targetDir) };
}

// إذا كان الملف المضغوط يحتوي مجلداً واحداً فقط بداخله package.json، نرفع محتواه إلى جذر مجلد البوت
function flattenSingleWrapperFolderIfNeeded(targetDir) {
  const rootPkg = path.join(targetDir, 'package.json');
  if (fs.existsSync(rootPkg)) {
    return;
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const visibleEntries = entries.filter((e) => !e.name.startsWith('__MACOSX'));
  if (visibleEntries.length === 1 && visibleEntries[0].isDirectory()) {
    const nestedDir = path.join(targetDir, visibleEntries[0].name);
    const nestedPkg = path.join(nestedDir, 'package.json');
    if (fs.existsSync(nestedPkg)) {
      const tempMoveDir = `${targetDir}_tmp_${Date.now()}`;
      fs.renameSync(nestedDir, tempMoveDir);
      for (const item of fs.readdirSync(targetDir)) {
        fs.rmSync(path.join(targetDir, item), { recursive: true, force: true });
      }
      for (const movedItem of fs.readdirSync(tempMoveDir)) {
        fs.renameSync(
          path.join(tempMoveDir, movedItem),
          path.join(targetDir, movedItem)
        );
      }
      fs.rmSync(tempMoveDir, { recursive: true, force: true });
    }
  }
}

// تنفيذ npm install ثم npm start للبوت
async function startBotPipeline(bot, options = { autoStartOnBoot: true }) {
  const existing = runningProcesses.get(bot.id);
  if (existing && (existing.status === 'running' || existing.status === 'installing')) {
    throw new Error('البوت قيد التشغيل أو التثبيت بالفعل.');
  }

  const botDir = path.join(BOTS_DIR, bot.id);
  const pkgPath = path.join(botDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    throw new Error('ملف package.json غير موجود داخل البوت.');
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    throw new Error('تعذر قراءة ملف package.json بصيغة JSON صحيحة.');
  }

  if (!pkgJson.scripts || typeof pkgJson.scripts.start !== 'string' || !pkgJson.scripts.start.trim()) {
    throw new Error('ملف package.json لا يحتوي على أمر "start" داخل "scripts".');
  }

  const shouldAutoStart = options.autoStartOnBoot !== false;
  const stateObj = { child: null, status: 'installing', intentionalStop: false };
  runningProcesses.set(bot.id, stateObj);
  setBotState(bot.id, { status: 'installing', pid: null, autoStartOnBoot: shouldAutoStart });

  appendLog(bot.id, `=== بدء تجهيز البوت: ${bot.name} ===`);
  appendLog(bot.id, `تنفيذ: npm install`);

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  await new Promise((resolve, reject) => {
    const installProc = spawn(npmCmd, ['install'], {
      cwd: botDir,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true
    });

    stateObj.child = installProc;

    installProc.stdout.on('data', (chunk) => {
      chunk
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => appendLog(bot.id, `[npm install] ${line}`));
    });

    installProc.stderr.on('data', (chunk) => {
      chunk
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => appendLog(bot.id, `[npm install err] ${line}`));
    });

    installProc.on('error', (err) => {
      reject(new Error(`فشل تشغيل npm install: ${err.message}`));
    });

    installProc.on('close', (code) => {
      if (stateObj.intentionalStop) {
        return reject(new Error('تم إيقاف عملية التثبيت يدوياً.'));
      }
      if (code === 0) {
        appendLog(bot.id, `اكتمل npm install بنجاح.`);
        resolve();
      } else {
        reject(new Error(`فشل npm install برمز الخروج: ${code}`));
      }
    });
  });

  if (stateObj.intentionalStop) {
    runningProcesses.delete(bot.id);
    setBotState(bot.id, { status: 'stopped', pid: null });
    return;
  }

  appendLog(bot.id, `تنفيذ: npm start (${pkgJson.scripts.start})`);

  const startProc = spawn(npmCmd, ['start'], {
    cwd: botDir,
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true
  });

  stateObj.child = startProc;
  stateObj.status = 'running';
  setBotState(bot.id, { status: 'running', pid: startProc.pid || null, autoStartOnBoot: shouldAutoStart });

  startProc.stdout.on('data', (chunk) => {
    chunk
      .toString('utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => appendLog(bot.id, line));
  });

  startProc.stderr.on('data', (chunk) => {
    chunk
      .toString('utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => appendLog(bot.id, `[STDERR] ${line}`));
  });

  startProc.on('error', (err) => {
    appendLog(bot.id, `[ERROR] فشل تشغيل البوت: ${err.message}`);
  });

  startProc.on('close', (code, signal) => {
    const wasIntentional = stateObj.intentionalStop;
    runningProcesses.delete(bot.id);
    setBotState(bot.id, { status: 'stopped', pid: null });

    if (wasIntentional) {
      appendLog(bot.id, `تم إيقاف البوت.`);
    } else {
      appendLog(bot.id, `توقف البوت (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`);
    }
  });
}

// إعادة تشغيل البوتات التي كانت مفعّلة للتشغيل التلقائي عند بدء تشغيل الاستضافة
async function restoreBotsAfterBoot() {
  const bots = loadBots();
  const botsToStart = bots.filter((b) => b.autoStartOnBoot === true);
  if (botsToStart.length === 0) {
    return;
  }

  console.log(`Restoring ${botsToStart.length} bot(s) marked for auto-start...`);
  for (const bot of botsToStart) {
    appendLog(bot.id, `=== استعادة تشغيل البوت تلقائياً بعد إقلاع الاستضافة ===`);
    startBotPipeline(bot, { autoStartOnBoot: true }).catch((err) => {
      runningProcesses.delete(bot.id);
      setBotState(bot.id, { status: 'stopped', pid: null });
      appendLog(bot.id, `[ERROR] فشل التشغيل التلقائي: ${err.message}`);
    });
  }
}

// إعداد رفع ملفات ZIP
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isZip =
      file.originalname.toLowerCase().endsWith('.zip') ||
      file.mimetype === 'application/zip' ||
      file.mimetype === 'application/x-zip-compressed';
    if (!isZip) {
      return cb(new Error('يجب رفع ملف مضغوط بصيغة .zip فقط.'));
    }
    cb(null, true);
  }
});

// جلب قائمة البوتات
app.get('/api/bots', (req, res) => {
  const bots = loadBots().map((bot) => {
    const live = runningProcesses.get(bot.id);
    return {
      ...bot,
      status: live ? live.status : 'stopped'
    };
  });
  res.json({ bots });
});

// عرض قائمة ملفات البوت
app.get('/api/bots/:id/files', (req, res) => {
  const { id } = req.params;
  const bot = loadBots().find((b) => b.id === id);
  if (!bot) {
    return res.status(404).json({ error: 'البوت غير موجود.' });
  }

  const botDir = path.join(BOTS_DIR, id);
  if (!fs.existsSync(botDir)) {
    return res.json({ files: [] });
  }

  try {
    const files = listBotFilesRecursive(botDir);
    return res.json({ files });
  } catch (err) {
    return res.status(500).json({ error: `فشل قراءة قائمة الملفات: ${err.message}` });
  }
});

// قراءة محتوى ملف داخل البوت
app.get('/api/bots/:id/file', (req, res) => {
  const { id } = req.params;
  const relPath = req.query.path;
  const bot = loadBots().find((b) => b.id === id);
  if (!bot) {
    return res.status(404).json({ error: 'البوت غير موجود.' });
  }

  const safePath = resolveSafeBotFilePath(id, relPath);
  if (!safePath) {
    return res.status(400).json({ error: 'مسار الملف غير صالح.' });
  }

  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    return res.status(404).json({ error: 'الملف غير موجود.' });
  }

  try {
    const stat = fs.statSync(safePath);
    if (stat.size > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'حجم الملف أكبر من 2MB ولا يمكن عرضه في المحرر النصي.' });
    }
    const content = fs.readFileSync(safePath, 'utf8');
    return res.json({ path: relPath.replace(/\\/g, '/').replace(/^\/+/, ''), content });
  } catch (err) {
    return res.status(500).json({ error: `تعذر قراءة الملف: ${err.message}` });
  }
});

// حفظ التعديلات على ملف داخل البوت
app.put('/api/bots/:id/file', (req, res) => {
  const { id } = req.params;
  const { path: relPath, content } = req.body || {};

  const bot = loadBots().find((b) => b.id === id);
  if (!bot) {
    return res.status(404).json({ error: 'البوت غير موجود.' });
  }

  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'محتوى الملف يجب أن يكون نصياً.' });
  }

  const safePath = resolveSafeBotFilePath(id, relPath);
  if (!safePath) {
    return res.status(400).json({ error: 'مسار الملف غير صالح.' });
  }

  try {
    fs.mkdirSync(path.dirname(safePath), { recursive: true });
    fs.writeFileSync(safePath, content, 'utf8');
    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    appendLog(id, `تم حفظ التعديلات على الملف: ${cleanRel}`);

    if (cleanRel === 'package.json') {
      try {
        const parsedPkg = JSON.parse(content);
        if (parsedPkg.scripts && typeof parsedPkg.scripts.start === 'string') {
          setBotState(id, { startScript: parsedPkg.scripts.start });
        }
      } catch {}
    }

    return res.json({ ok: true, message: `تم حفظ الملف "${cleanRel}" بنجاح.` });
  } catch (err) {
    return res.status(500).json({ error: `فشل حفظ الملف: ${err.message}` });
  }
});

// رفع ملف ZIP وإنشاء بوت جديد
app.post('/api/bots/upload', upload.single('botZip'), (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) {
    return res.status(400).json({ error: 'لم يتم استلام ملف .zip.' });
  }

  const botId = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const botDir = path.join(BOTS_DIR, botId);
  const rawName = (req.body.botName || uploadedFile.originalname.replace(/\.zip$/i, '')).trim();
  const botName = rawName || botId;

  try {
    fs.mkdirSync(botDir, { recursive: true });
    const zip = new AdmZip(uploadedFile.path);
    zip.extractAllTo(botDir, true);
    flattenSingleWrapperFolderIfNeeded(botDir);

    const pkgPath = path.join(botDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.rmSync(botDir, { recursive: true, force: true });
      fs.unlinkSync(uploadedFile.path);
      return res.status(400).json({
        error: 'الملف المضغوط لا يحتوي على package.json في جذر المشروع.'
      });
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts || typeof pkg.scripts.start !== 'string' || !pkg.scripts.start.trim()) {
      fs.rmSync(botDir, { recursive: true, force: true });
      fs.unlinkSync(uploadedFile.path);
      return res.status(400).json({
        error: 'ملف package.json يجب أن يحتوي على أمر "start" داخل "scripts".'
      });
    }

    fs.unlinkSync(uploadedFile.path);

    const newBot = {
      id: botId,
      name: botName,
      startScript: pkg.scripts.start,
      status: 'stopped',
      autoStartOnBoot: false,
      createdAt: new Date().toISOString()
    };

    const bots = loadBots();
    bots.push(newBot);
    saveBots(bots);

    logHistory.set(botId, []);
    appendLog(botId, `تم رفع وفك ضغط "${botName}" بنجاح. أمر البدء: ${pkg.scripts.start}`);

    return res.status(201).json({ bot: newBot });
  } catch (err) {
    if (fs.existsSync(botDir)) {
      try {
        fs.rmSync(botDir, { recursive: true, force: true });
      } catch {}
    }
    if (uploadedFile && fs.existsSync(uploadedFile.path)) {
      try {
        fs.unlinkSync(uploadedFile.path);
      } catch {}
    }
    return res.status(500).json({ error: `فشل معالجة الملف المضغوط: ${err.message}` });
  }
});

// تشغيل البوت
app.post('/api/bots/:id/start', async (req, res) => {
  const { id } = req.params;
  const bot = loadBots().find((b) => b.id === id);
  if (!bot) {
    return res.status(404).json({ error: 'البوت غير موجود.' });
  }

  try {
    startBotPipeline(bot, { autoStartOnBoot: true }).catch((err) => {
      runningProcesses.delete(id);
      setBotState(id, { status: 'stopped', pid: null });
      appendLog(id, `[ERROR] ${err.message}`);
    });
    return res.json({ ok: true, message: 'بدأ تنفيذ التثبيت والتشغيل.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// إيقاف البوت
app.post('/api/bots/:id/stop', async (req, res) => {
  const { id } = req.params;
  const bot = loadBots().find((b) => b.id === id);
  if (!bot) {
    return res.status(404).json({ error: 'البوت غير موجود.' });
  }

  await killBotProcess(id);
  return res.json({ ok: true, message: 'تم إيقاف البوت.' });
});

// إعادة تشغيل البوت
app.post('/api/bots/:id/restart', async (req, res) => {
  const { id } = req.params;
  const bot = loadBots().find((b) => b.id === id);
  if (!bot) {
    return res.status(404).json({ error: 'البوت غير موجود.' });
  }

  appendLog(id, `=== إعادة تشغيل البوت ===`);
  await killBotProcess(id);

  startBotPipeline(bot, { autoStartOnBoot: true }).catch((err) => {
    runningProcesses.delete(id);
    setBotState(id, { status: 'stopped', pid: null });
    appendLog(id, `[ERROR] ${err.message}`);
  });

  return res.json({ ok: true, message: 'جاري إعادة التشغيل.' });
});

// حذف البوت وملفاته بأمان دون إسقاط السيرفر
app.delete('/api/bots/:id', async (req, res) => {
  const { id } = req.params;
  const bots = loadBots();
  const exists = bots.some((b) => b.id === id);
  if (!exists) {
    return res.status(404).json({ error: 'البوت غير موجود.' });
  }

  try {
    await killBotProcess(id);

    const botDir = path.join(BOTS_DIR, id);
    const removal = await removeDirectoryWithRetry(botDir);

    logHistory.delete(id);
    logClients.delete(id);

    const updated = bots.filter((b) => b.id !== id);
    saveBots(updated);

    if (!removal.deleted) {
      return res.status(200).json({
        ok: true,
        message: 'تم إزالة البوت من القائمة، لكن بعض الملفات لا تزال مقفلة مؤقتاً في المجلد.'
      });
    }

    return res.json({ ok: true, message: 'تم حذف البوت بالكامل.' });
  } catch (err) {
    return res.status(500).json({ error: `حدث خطأ أثناء الحذف: ${err.message}` });
  }
});

// بث السجلات الحية عبر Server-Sent Events (SSE)
app.get('/api/bots/:id/logs', (req, res) => {
  const { id } = req.params;
  const bot = loadBots().find((b) => b.id === id);
  if (!bot) {
    return res.status(404).end('Bot not found');
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const history = logHistory.get(id) || [];
  res.write(`data: ${JSON.stringify({ history })}\n\n`);

  if (!logClients.has(id)) {
    logClients.set(id, new Set());
  }
  logClients.get(id).add(res);

  req.on('close', () => {
    const clients = logClients.get(id);
    if (clients) {
      clients.delete(res);
    }
  });
});

// معالجة أخطاء multer
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, HOST, () => {
  console.log(`Bot Host Panel running at http://${HOST}:${PORT}`);
  restoreBotsAfterBoot();
});