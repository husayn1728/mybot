require('dotenv').config();
const config = require('./config');
process.env.TZ = config.timezone;

const mongoose = require('mongoose');
const express = require('express');
const { Telegraf, Markup, session, Input } = require('telegraf');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const NodeID3 = require('node-id3');
const ffmpeg = require('ffmpeg-static');

const mongoConnection = mongoose.connect(config.mongoUri, {
  serverSelectionTimeoutMS: 10000
});

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true, index: true },
  username: { type: String, default: '' },
  nickname: { type: String, default: '' },
  joinedAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now }
}, { versionKey: false });

const adminSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true, index: true },
  username: { type: String, default: '' },
  nickname: { type: String, default: '' },
  permissions: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const sessionSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 }
}, { versionKey: false });

const broadcastSchema = new mongoose.Schema({
  total: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  blocked: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const adminLogSchema = new mongoose.Schema({
  adminTelegramId: { type: Number, required: true, index: true },
  adminName: { type: String, default: '' },
  action: { type: String, required: true },
  details: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true }
}, { versionKey: false });

const botConfigSchema = new mongoose.Schema({
  configKey: { type: String, default: 'main_config', unique: true },
  channels: { type: Array, default: [] },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { versionKey: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Admin = mongoose.models.BotAdmin || mongoose.model('BotAdmin', adminSchema);
const BotConfig = mongoose.models.BotConfig || mongoose.model('BotConfig', botConfigSchema);
const Session = mongoose.models.BotSession || mongoose.model('BotSession', sessionSchema);
const Broadcast = mongoose.models.Broadcast || mongoose.model('Broadcast', broadcastSchema);
const AdminLog = mongoose.models.AdminLog || mongoose.model('AdminLog', adminLogSchema);

const app = express();
const port = Number(process.env.PORT) || 3000;
app.get('/', (req, res) => res.send('Music bot ishlamoqda...'));
app.get('/health', (req, res) => res.status(200).json({
  ok: true,
  mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
}));
app.listen(port, '0.0.0.0', () => console.log(`Express server ${port} portda ishlayapti.`));

const bot = new Telegraf(config.botToken);
const ADMIN_USERNAME = config.admin.username;
const ADMIN_TG_ID = config.admin.telegramId;
const adminPermissions = ['broadcast', 'stats', 'settings', 'admins'];
const adminRegistry = new Map();
const joinRequestQueue = new Map();
const data = { settings: { requiredChannels: [], joinApprovalMode: 'auto' } };
const premiumEmojis = {
  welcome: '<tg-emoji emoji-id="5199785165735367039">⚡️</tg-emoji>',
  bot: '<tg-emoji emoji-id="5323359973365784232">🤖</tg-emoji>',
  confirm: '<tg-emoji emoji-id="5393275607083676065">✔️</tg-emoji>',
  warning: '<tg-emoji emoji-id="5215351548850218245">⚠️</tg-emoji>',
  web: '<tg-emoji emoji-id="5231482153228835967">🌐</tg-emoji>'
};
const defaultMessages = {
  welcome: `${premiumEmojis.welcome} Assalomu alaykum {nickname}\n\n${premiumEmojis.bot} @{bot_username} orqali siz musiqani tezda topishingiz mumkin\n${premiumEmojis.confirm} Musiqa nomi yoki artistini yuboring va natijalarni tanlang`,
  subscriptionRequired: `${premiumEmojis.warning} Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling`,
  invalidCode: '<tg-emoji emoji-id="5212992409213872592">❌</tg-emoji> Noto\'g\'ri kirish. Musiqa nomini yoki artistini yuboring.',
  nonNumericCode: 'Musiqa qidirishda faqat matn kiriting. Qayta yuboring.',
  help: `${premiumEmojis.web} Musiqa qidirish uchun /music yoki "🎵 Musiqa qidirish" tugmasini bosing.\n\nYordam olish uchun "❓ Yordam" tugmasini tanlang.`
};
function isAdmin(ctx) {
  const telegramId = Number(ctx.from?.id);
  if (telegramId === ADMIN_TG_ID || ctx.from?.username?.toLowerCase() === ADMIN_USERNAME) return true;
  const record = adminRegistry.get(telegramId);
  return Boolean(record?.active);
}

function isOwner(ctx) {
  return Number(ctx.from?.id) === ADMIN_TG_ID || ctx.from?.username?.toLowerCase() === ADMIN_USERNAME;
}

function hasPermission(ctx, permission) {
  if (isOwner(ctx)) return true;
  const record = adminRegistry.get(Number(ctx.from?.id));
  return Boolean(record?.active && record.permissions.includes(permission));
}

function permissionsLabel(permissions) {
  const labels = { broadcast: 'Xabar yuborish', stats: 'Statistika', settings: 'Sozlamalar', admins: 'Adminlar' };
  return permissions.map((permission) => labels[permission] || permission).join(', ') || 'Huquq berilmagan';
}

function adminManagementKeyboard(admin) {
  const rows = adminPermissions.map((permission) => [Markup.button.callback(
    `${admin.permissions.includes(permission) ? '✅' : '⬜'} ${permission}`,
    `admin:perm:${admin.telegramId}:${permission}`
  )]);
  rows.push([Markup.button.callback('🗑 Adminni o\'chirish', `admin:remove:${admin.telegramId}`)]);
  rows.push([Markup.button.callback('⬅️ Adminlar ro\'yxati', 'admin:admins')]);
  return Markup.inlineKeyboard(rows);
}

async function refreshAdminRegistry() {
  adminRegistry.clear();
  const admins = await Admin.find({ active: true }).lean();
  admins.forEach((admin) => adminRegistry.set(admin.telegramId, admin));
}

async function logAdminAction(ctx, action, details = '') {
  if (!ctx.from?.id) return;
  try {
    await AdminLog.create({
      adminTelegramId: Number(ctx.from.id),
      adminName: ctx.from.first_name || ctx.from.username || '',
      action,
      details
    });
  } catch (error) {
    console.error('Admin log failed:', error.message);
  }
}

function reset(ctx) {
  ctx.session = {};
}

function activateAdminPanel(ctx) {
  ctx.session = { adminPanelActive: true };
}

function isAdminPanelActive(ctx) {
  return isAdmin(ctx) && ctx.session?.adminPanelActive === true;
}

function shouldProtectContent(chatId) {
  return Number(chatId) !== ADMIN_TG_ID;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeChannel(value) {
  const trimmed = String(value || '').trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isYoutubeUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be');
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildYoutubeSearchUrl(query, key) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '10',
    q: query,
    key
  });
  return `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
}

function isSupportedMediaUrl(value) {
  try {
    const url = new URL(value);
    return /(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|twitter\.com|x\.com|vimeo\.com|facebook\.com|soundcloud\.com|spotify\.com|vk\.com)/i.test(url.hostname);
  } catch {
    return false;
  }
}

function youtubeVideoFormatFilter(format = 'best') {
  const normalized = String(format || 'best').toLowerCase();
  return normalized === 'audio' ? 'bestaudio/best' : 'mp4/bestvideo+bestaudio';
}

function buildYoutubeVideosUrl(ids, key) {
  const params = new URLSearchParams({
    part: 'contentDetails',
    id: ids.join(','),
    key
  });
  return `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
}

function normalizeYouTubeSearchResult(item) {
  const videoId = item?.id?.videoId || item?.id || '';
  const title = item?.snippet?.title || 'Noma\'lum musiqa';
  const artist = item?.snippet?.channelTitle || 'Noma\'lum artist';
  const thumbnail = item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.default?.url || '';
  return {
    id: String(videoId),
    title: String(title).replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Noma\'lum musiqa',
    artist: String(artist).trim() || 'Noma\'lum artist',
    duration: '',
    thumbnail,
    downloadUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''
  };
}

async function addYoutubeDurations(items, key) {
  const ids = items.map((item) => item.id).filter(Boolean);
  if (!ids.length) return items;

  try {
    const response = await fetchWithTimeout(buildYoutubeVideosUrl(ids, key));
    if (!response.ok) return items;
    const payload = await response.json();
    const durations = new Map((payload.items || []).map((item) => [
      String(item.id),
      formatMusicDuration(item.contentDetails?.duration)
    ]));
    return items.map((item) => ({ ...item, duration: durations.get(item.id) || '' }));
  } catch (error) {
    console.warn('YouTube duration lookup failed:', error.message || error);
    return items;
  }
}

async function searchMusic(query) {
  const key = config.youtubeApiKey;
  const response = await fetchWithTimeout(buildYoutubeSearchUrl(query, key));
  if (!response.ok) {
    const reason = await response.text().catch(() => '');
    throw new Error(`YouTube qidiruvi ishlamadi: ${reason || response.statusText}`);
  }

  const payload = await response.json();
  const items = (payload.items || [])
    .filter((item) => item?.id?.videoId)
    .map(normalizeYouTubeSearchResult);
  if (!items.length) return [];
  return addYoutubeDurations(items, key);
}

function formatMusicDuration(value) {
  if (typeof value === 'number') {
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return '';
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function resolveFfmpegLocation() {
  const dirs = [process.env.FFMPEG_LOCATION, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  for (const dir of dirs) {
    if (fsSync.existsSync(path.join(dir, 'ffmpeg'))) return dir;
  }
  if (ffmpeg && fsSync.existsSync(ffmpeg)) return ffmpeg;
  return null; // yt-dlp PATH'dan o'zi qidiradi
}

async function downloadMusicMp3(result) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'music-download-'));
  const outputPath = path.join(tempDir, 'music.mp3');

  try {
    const rawUrl = String(result?.downloadUrl || '');
    const title = result?.title || 'Noma\'lum musiqa';
    const artist = result?.artist || 'Noma\'lum artist';

    if (!isYoutubeUrl(rawUrl)) {
      throw new Error('Faqat YouTube musiqalari qo\'llab-quvvatlanadi.');
    }

    const { spawn } = require('child_process');
    const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
    const ffmpegLocation = resolveFfmpegLocation();
    const args = [
      rawUrl,
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '--max-filesize', '48M',
      '--no-warnings',
      '--no-progress',
      '-o', path.join(tempDir, 'music.%(ext)s')
    ];
    if (ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation);
    if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);

    await new Promise((resolve, reject) => {
      const proc = spawn(ytdlpPath, args);
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('yt-dlp vaqt tugadi (3 daqiqa).'));
      }, 3 * 60 * 1000);

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => { stderr += chunk; });
      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(error.code === 'ENOENT'
          ? new Error('yt-dlp o\'rnatilmagan (brew install yt-dlp).')
          : error);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const lastLine = stderr.trim().split('\n').filter(Boolean).pop() || '';
        reject(new Error(`yt-dlp xatosi (${code}): ${lastLine}`));
      });
    });

    const stats = await fs.stat(outputPath).catch(() => null);
    if (!stats || stats.size < 1024) {
      throw new Error('Musiqa fayli yetarli emas yoki buzilgan.');
    }

    const tagResult = NodeID3.write({ title, artist, album: 'MusicBot' }, outputPath);
    if (tagResult !== true) {
      throw new Error('MP3 metadata yozilmadi.');
    }

    return { filePath: outputPath, tempDir, title, artist };
  } catch (error) {
    console.error('DETAILED_RUNTIME_ERROR:', error);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('MUSIC_CLEANUP_ERROR:', cleanupError);
    }
    throw error;
  }
}

function joinRequestKeyboard() {
  const mode = data.settings.joinApprovalMode || 'auto';
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${mode === 'auto' ? '✅' : '⬜'} Avtomatik qabul qilish`, 'admin:join_mode:auto')],
    [Markup.button.callback(`${mode === 'batch' ? '✅' : '⬜'} To\'planganlarni bittada qabul qilish`, 'admin:join_mode:batch')],
    [Markup.button.callback('📦 Kutilayotganlar ro\'yxatini qabul qilish', 'admin:approve_pending_joins')],
    [Markup.button.callback('⬅️ Admin panel', 'admin:panel')]
  ]);
}

function adminKeyboard() {
  const ctx = arguments[0];
  const can = (permission) => !ctx || hasPermission(ctx, permission);
  const rows = [];
  if (can('stats')) rows.push([
    Markup.button.callback('📊 Statistika', 'admin:stats')
  ]);
  if (can('broadcast')) rows.push([
    Markup.button.callback('📣 Xabar yuborish', 'admin:broadcast')
  ]);
  if (can('settings')) rows.push([
    Markup.button.callback('📢 Obuna kanalini qo\'shish', 'admin:subscription'),
    Markup.button.callback('📋 Obuna kanallari', 'admin:required_list')
  ]);
  if (can('settings')) rows.push([
    Markup.button.callback('❌ Obunani o\'chirish', 'admin:subscription_off')
  ]);
  if (can('settings')) rows.push([
    Markup.button.callback('🔐 Maxfiy kanalga qo\'shilish', 'admin:join_requests')
  ]);
  if (isOwner(ctx || {})) rows.push([Markup.button.callback('👥 Adminlarni boshqarish', 'admin:admins')]);
  if (isOwner(ctx || {})) rows.push([Markup.button.callback('🧾 Admin loglari', 'admin:logs')]);
  rows.push([Markup.button.callback('🚪 Paneldan chiqish', 'admin:exit')]);
  return Markup.inlineKeyboard(rows);
}

function userKeyboard(ctx) {
  return isAdmin(ctx) ? Markup.keyboard([['Admin panel']]).resize() : Markup.removeKeyboard();
}

const persistentSessionStore = {
  async get(key) {
    const record = await Session.findOne({ key }).lean();
    return record?.data;
  },
  async set(key, value) {
    await Session.findOneAndUpdate(
      { key },
      { $set: { data: value, updatedAt: new Date() } },
      { upsert: true }
    );
  },
  async delete(key) {
    await Session.deleteOne({ key });
  }
};

function formatMessage(template, ctx, values = {}) {
  const nickname = ctx.from?.first_name || ctx.from?.username || 'foydalanuvchi';
  return String(template).replace(/\{(nickname|bot_username|code)\}/g, (match, key) => ({
    nickname,
    bot_username: config.botUsername,
    code: values.code || ''
  }[key] ?? match));
}

function configuredMessage(key, ctx, values = {}) {
  return formatMessage(data.settings.messages?.[key] || defaultMessages[key], ctx, values);
}

function replyOptions(replyMarkup) {
  return replyMarkup ? { parse_mode: 'HTML', reply_markup: replyMarkup } : { parse_mode: 'HTML' };
}

function welcomeMessage(ctx) {
  return configuredMessage('welcome', ctx);
}

function welcomeMarkup(ctx) {
  const rows = [
    [{ text: '🎵 Musiqa qidirish', callback_data: 'music:search', style: 'success' }],
    [{ text: '❓ Yordam', callback_data: 'help', style: 'success' }]
  ];
  if (isAdmin(ctx)) rows.push([{ text: '🛠 Admin panel', callback_data: 'admin:panel', style: 'success' }]);
  return Markup.inlineKeyboard(rows).reply_markup;
}

function subscriptionKeyboard(channels) {
  const rows = channels.map((channel, index) => [Markup.button.url(
    `📢 ${index + 1} - kanal`,
    `https://t.me/${String(channel.username).replace(/^@/, '')}`
  )]);
  rows.push([Markup.button.callback('✅ Tekshirish', 'check_subscription')]);
  return Markup.inlineKeyboard(rows);
}

async function getRequiredChannels() {
  const configDocument = await BotConfig.findOne({ configKey: 'main_config' }, { channels: 1 }).lean();
  return configDocument?.channels || data.settings.requiredChannels || [];
}

async function requiredSubscription(ctx) {
  if (isAdmin(ctx)) return true;
  const channels = await getRequiredChannels();
  if (!channels.length) return true;

  const notSubscribed = [];
  for (const channel of channels) {
    try {
      const member = await ctx.telegram.getChatMember(channel.id, ctx.from.id);
      if (!['creator', 'administrator', 'member'].includes(member.status)) notSubscribed.push(channel);
    } catch (error) {
      console.error('Subscription check failed:', error.response?.description || error.message);
      notSubscribed.push(channel);
    }
  }

  if (!notSubscribed.length) return true;
  await ctx.reply(configuredMessage('subscriptionRequired', ctx), replyOptions(subscriptionKeyboard(notSubscribed).reply_markup));
  return false;
}

async function checkFullAdmin(ctx, username) {
  const chat = await ctx.telegram.getChat(username);
  if (chat.type !== 'channel') throw new Error('Bu username kanalga tegishli emas.');

  const userMember = await ctx.telegram.getChatMember(chat.id, ctx.from.id);
  if (!['creator', 'administrator'].includes(userMember.status)) {
    throw new Error('Kanalni qo\'shish uchun kanalda admin yoki ega bo\'lishingiz kerak.');
  }
  const botInfo = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(chat.id, botInfo.id);
  if (!['creator', 'administrator'].includes(member.status)) {
    throw new Error('Bot kanalida administrator bo\'lishi kerak.');
  }
  if (member.status === 'administrator' && member.can_post_messages === false) {
    throw new Error('Botga kanalda post yuborish huquqini bering.');
  }
  return { id: chat.id, title: chat.title || username, username: chat.username ? `@${chat.username}` : username };
}

async function approveChatJoinRequestForBot(ctx, chatId, userId) {
  if (!chatId || !userId) return { approved: false, reason: 'Noto\'g\'ri foydalanuvchi yoki chat identifikatori.' };

  try {
    const botInfo = await ctx.telegram.getMe();
    const botMember = await ctx.telegram.getChatMember(chatId, botInfo.id);
    if (!['creator', 'administrator'].includes(botMember.status)) {
      return { approved: false, reason: 'Bot bu kanalga admin qilinmagan.' };
    }

    await ctx.telegram.approveChatJoinRequest(chatId, userId);
    return { approved: true };
  } catch (error) {
    console.error('approveChatJoinRequest failed:', error.response?.description || error.message);
    return { approved: false, reason: error.response?.description || error.message };
  }
}

async function batchApprovePendingJoinRequests(ctx, chatId) {
  const targetChatId = Number(chatId || ctx.chat?.id || ctx.update?.chat_join_request?.chat?.id || 0);
  if (!targetChatId) {
    return { approved: 0, total: 0, queued: 0 };
  }

  const pending = joinRequestQueue.get(targetChatId) || [];
  if (!pending.length) {
    return { approved: 0, total: 0, queued: 0 };
  }

  let approved = 0;
  for (const item of pending) {
    const result = await approveChatJoinRequestForBot(ctx, targetChatId, item.userId);
    if (result.approved) approved += 1;
  }

  joinRequestQueue.delete(targetChatId);
  return { approved, total: pending.length, queued: pending.length };
}

function enqueueJoinRequest(chatId, request) {
  const id = Number(chatId);
  if (!id || !request?.userId) return false;
  const list = joinRequestQueue.get(id) || [];
  const exists = list.some((item) => item.userId === Number(request.userId));
  if (exists) return false;
  list.push(request);
  joinRequestQueue.set(id, list);
  return true;
}

async function saveSettings() {
  await BotConfig.findOneAndUpdate(
    { configKey: 'main_config' },
    { $set: {
      channels: data.settings.requiredChannels,
      settings: {
        messages: data.settings.messages,
        joinApprovalMode: data.settings.joinApprovalMode || 'auto'
      }
    } },
    { upsert: true }
  );
}

async function hydrateSettings() {
  await mongoConnection;
  const admins = await Admin.find({ active: true }).lean();
  adminRegistry.clear();
  admins.forEach((admin) => adminRegistry.set(admin.telegramId, admin));
  let configDocument = await BotConfig.findOne({ configKey: 'main_config' }).lean();
  if (!configDocument) {
    configDocument = await BotConfig.create({ configKey: 'main_config', channels: [], settings: {} });
    configDocument = configDocument.toObject();
  }
  data.settings.requiredChannels = configDocument.channels || [];
  data.settings.joinApprovalMode = configDocument.settings?.joinApprovalMode || 'auto';
  data.settings.messages = { ...defaultMessages };
}

async function ensureUser(ctx) {
  const telegramId = Number(ctx.from.id);
  const existingUser = await User.findOne({ telegramId }).lean();
  const userData = {
    username: ctx.from.username || '',
    nickname: ctx.from.first_name || ctx.from.last_name || '',
    lastActiveAt: new Date()
  };
  if (existingUser) {
    await User.updateOne({ telegramId }, { $set: userData });
    return { user: { ...existingUser, ...userData }, isNew: false };
  }
  try {
    const user = await User.create({ telegramId, ...userData });
    return { user: user.toObject(), isNew: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
    await User.updateOne({ telegramId }, { $set: userData });
    return { user: await User.findOne({ telegramId }).lean(), isNew: false };
  }
}

async function notifyNewSubscriber(ctx) {
  if (isAdmin(ctx)) return;
  const count = await User.countDocuments();
  const nickname = escapeHtml(ctx.from.first_name || ctx.from.last_name || ctx.from.username || 'foydalanuvchi');
  const profileLink = `<a href="tg://user?id=${Number(ctx.from.id)}">${nickname}</a>`;
  await bot.telegram.sendMessage(
    ADMIN_TG_ID,
    `Botga yangi obunachi qo'shildi: ${profileLink}\nObunachilar soni: ${count}`,
    { parse_mode: 'HTML', protect_content: false }
  );
}

function broadcastKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➡️ Rasmsiz davom etish', 'broadcast:no_media')],
    [Markup.button.callback('❌ Bekor qilish', 'broadcast:cancel')]
  ]);
}

function broadcastButtonKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Yana tugma qo\'shish', 'broadcast:add_button')],
    [Markup.button.callback('👁 Preview', 'broadcast:preview')],
    [Markup.button.callback('❌ Bekor qilish', 'broadcast:cancel')]
  ]);
}

function broadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📤 Yuborish', 'broadcast:send')],
    [Markup.button.callback('❌ Bekor qilish', 'broadcast:cancel')]
  ]);
}

function broadcastColorKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔵 Ko\'k', 'broadcast:color:blue'), Markup.button.callback('🟢 Yashil', 'broadcast:color:green')],
    [Markup.button.callback('🔴 Qizil', 'broadcast:color:red')]
  ]);
}

function broadcastExtra(broadcast, chatId) {
  const replyMarkup = broadcast.buttons?.length
    ? Markup.inlineKeyboard(broadcast.buttons).reply_markup
    : undefined;
  const commonExtra = replyMarkup ? { reply_markup: replyMarkup } : {};
  commonExtra.protect_content = shouldProtectContent(chatId);
  const textExtra = {
    ...commonExtra,
    ...(broadcast.captionEntities?.length
      ? { entities: broadcast.captionEntities }
      : { parse_mode: 'HTML' })
  };
  const mediaExtra = {
    ...commonExtra,
    ...(broadcast.captionEntities?.length
      ? { caption_entities: broadcast.captionEntities }
      : { parse_mode: 'HTML' })
  };
  return { textExtra, mediaExtra };
}

async function sendBroadcastMessage(chatId, broadcast) {
  const { textExtra, mediaExtra } = broadcastExtra(broadcast, chatId);
  if (broadcast.mediaType === 'photo') {
    return bot.telegram.sendPhoto(chatId, broadcast.media, { ...mediaExtra, caption: broadcast.caption || undefined });
  }
  if (broadcast.mediaType === 'video') {
    return bot.telegram.sendVideo(chatId, broadcast.media, { ...mediaExtra, caption: broadcast.caption || undefined });
  }
  if (broadcast.mediaType === 'animation') {
    return bot.telegram.sendAnimation(chatId, broadcast.media, { ...mediaExtra, caption: broadcast.caption || undefined });
  }
  return bot.telegram.sendMessage(chatId, broadcast.caption || ' ', textExtra);
}

async function previewBroadcast(ctx) {
  const broadcast = ctx.session?.broadcast;
  if (!broadcast) return ctx.reply('Xabar yuborish jarayoni topilmadi.');
  try {
    await sendBroadcastMessage(ctx.from.id, broadcast);
    broadcast.previewed = true;
    return ctx.reply('Preview yuborildi. Tekshirib, yuborishni tasdiqlang.', broadcastConfirmKeyboard());
  } catch (error) {
    return ctx.reply(`Preview yuborilmadi: ${error.response?.description || error.message}`);
  }
}

async function sendBroadcast(ctx) {
  const broadcast = ctx.session?.broadcast;
  if (!broadcast) return ctx.reply('Xabar yuborish jarayoni topilmadi.');
  const users = await User.find({}, { telegramId: 1 }).lean();
  const log = await Broadcast.create({ total: users.length });
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  let processed = 0;
  for (const user of users) {
    try {
      const chat = await bot.telegram.getChat(user.telegramId);
      if (chat.type !== 'private') continue;
      await sendBroadcastMessage(user.telegramId, broadcast);
      sent += 1;
    } catch (error) {
      failed += 1;
      if (error.response?.error_code === 403) blocked += 1;
      console.error(`Broadcast to ${user.telegramId} failed:`, error.response?.description || error.message);
    }
    processed += 1;
    if (processed % 25 === 0 || processed === users.length) {
      await ctx.telegram.sendMessage(ctx.from.id, `Broadcast progress: ${processed} / ${users.length} yuborildi`, { protect_content: false });
    }
  }
  await Broadcast.updateOne({ _id: log._id }, { $set: { sent, failed, blocked } });
  return { total: users.length, sent, failed, blocked };
}

async function adminStats(ctx) {
  const now = Date.now();
  const [subscribers, activeUsers, broadcasts] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ lastActiveAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
    Broadcast.aggregate([{ $group: { _id: null, total: { $sum: 1 }, sent: { $sum: '$sent' }, failed: { $sum: '$failed' }, blocked: { $sum: '$blocked' } } }])
  ]);
  const broadcastStats = broadcasts[0] || { total: 0, sent: 0, failed: 0, blocked: 0 };
  return ctx.reply(`<tg-emoji emoji-id="5244825199278311613">📊</tg-emoji> Bot statistikasi\n\n` +
    `<blockquote>Obunachilar: ${subscribers}\nFaol userlar (24 soat): ${activeUsers}</blockquote>\n\n` +
    `<blockquote>Broadcastlar: ${broadcastStats.total}\nYetib borgan: ${broadcastStats.sent}\nBloklagan: ${broadcastStats.blocked}\nXatolik: ${broadcastStats.failed}</blockquote>`,
    replyOptions(adminKeyboard(ctx).reply_markup));
}

async function handleStart(ctx) {
  const registration = await ensureUser(ctx);
  if (registration.isNew) {
    try {
      await notifyNewSubscriber(ctx);
    } catch (error) {
      console.error('New subscriber notification failed:', error.response?.description || error.message);
    }
  }
  if (!(await requiredSubscription(ctx))) return;
  const payload = ctx.startPayload || '';
  return ctx.reply(welcomeMessage(ctx), replyOptions(welcomeMarkup(ctx) || userKeyboard(ctx).reply_markup));
}

bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') return;
  return next();
});

bot.use(session({ store: persistentSessionStore }));

bot.use(async (ctx, next) => {
  const reply = ctx.reply.bind(ctx);
  ctx.reply = (text, extra = {}) => reply(text, { ...(extra || {}), protect_content: !isAdmin(ctx) });
  return next();
});

bot.start(handleStart);

bot.use(async (ctx, next) => {
  if (ctx.from && ctx.message?.text !== '/start') await ensureUser(ctx);
  if (ctx.callbackQuery?.data === 'check_subscription') return next();
  if (ctx.callbackQuery?.data && isAdmin(ctx) &&
      /^(?:admin:|broadcast:)/.test(ctx.callbackQuery.data) &&
      ctx.callbackQuery.data !== 'admin:panel' && !isAdminPanelActive(ctx)) {
    await ctx.answerCbQuery('Avval /admin orqali panelni oching.', { show_alert: true });
    return;
  }
  if (ctx.callbackQuery?.data && isAdmin(ctx)) {
    const permission = permissionForCallback(ctx.callbackQuery.data);
    if (permission && !hasPermission(ctx, permission)) {
      await ctx.answerCbQuery('Bu amal uchun sizda huquq yo\'q.', { show_alert: true });
      return;
    }
  }
  if (isAdmin(ctx)) return next();
  if (await requiredSubscription(ctx)) return next();
});

bot.action('check_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  if (await requiredSubscription(ctx)) return ctx.reply(welcomeMessage(ctx), replyOptions(welcomeMarkup(ctx) || userKeyboard(ctx).reply_markup));
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(configuredMessage('help', ctx), replyOptions());
});

bot.action('music:search', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'music_search' };
  return ctx.reply('🎵 Musiqa nomi yoki artistini yuboring:', replyOptions());
});

async function replyMusicResults(ctx, query) {
  try {
    const items = await searchMusic(query);
    if (!items.length) return ctx.reply('Musiqa topilmadi. Boshqa nom yoki artist yuboring:', replyOptions());
    const results = items.map((item) => ({
      id: item.id,
      title: item.title,
      artist: item.artist,
      duration: item.duration,
      downloadUrl: item.downloadUrl,
      source: item.source
    }));
    ctx.session = { step: 'music_pick', musicResults: results };
    const rows = [];
    for (let index = 0; index < results.length; index += 5) {
      rows.push(results.slice(index, index + 5).map((result, offset) => Markup.button.callback(
        String(index + offset + 1),
        `music:pick:${index + offset}`
      )));
    }
    const list = results.map((result, index) => {
      const duration = result.duration ? ` ${result.duration}` : '';
      return `${index + 1}. ${escapeHtml(result.artist)} - ${escapeHtml(result.title)}${duration}`;
    }).join('\n');
    return ctx.reply(`<b>🎵 Qidiruv natijalari:</b>\n\n${list}\n\nRaqamini tanlang:`, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(rows).reply_markup
    });
  } catch (error) {
    console.error('Music search failed:', error.message);
    const message = String(error?.message || error || '');
    if (/429|Too Many Requests|quota|dailyLimitExceeded|rateLimitExceeded/i.test(message)) {
      return ctx.reply('YouTube API limiti tugadi. Bir ozdan keyin qayta urinib ko\'ring yoki boshqa nom bilan qidiring.', replyOptions());
    }
    return ctx.reply(error.message, replyOptions());
  }
}

bot.action(/^music:pick:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const index = Number(ctx.match[1]);
  const result = ctx.session?.musicResults?.[index];
  if (!result) return ctx.reply('Musiqa tanlovi eskirgan. Qaytadan qidiring:', replyOptions());
  const status = await ctx.reply('⏳ MP3 tayyorlanmoqda...');
  let music;
  try {
    music = await downloadMusicMp3(result);
    const fileBuffer = await fs.readFile(music.filePath);
    const audioInput = Input.fromBuffer(fileBuffer, `${music.title}.mp3`);
    try {
      await ctx.telegram.sendAudio(ctx.from.id, audioInput, {
        title: music.title,
        performer: music.artist,
        caption: `<b>${escapeHtml(music.title)}</b>\n🎤 ${escapeHtml(music.artist)}`,
        parse_mode: 'HTML',
        protect_content: shouldProtectContent(ctx.from.id)
      });
    } catch (audioError) {
      console.error('AUDIO_UPLOAD_FALLBACK_ERROR:', audioError);
      await ctx.telegram.sendDocument(ctx.from.id, audioInput, {
        caption: `<b>${escapeHtml(music.title)}</b>\n🎤 ${escapeHtml(music.artist)}`,
        parse_mode: 'HTML',
        protect_content: shouldProtectContent(ctx.from.id)
      });
    }
  } catch (error) {
    console.error('DETAILED_RUNTIME_ERROR:', error);
    const detail = isAdmin(ctx) ? `\n\nTexnik sabab: ${escapeHtml(String(error.message || error).slice(0, 900))}` : '';
    const fallbackUrl = isHttpUrl(result?.downloadUrl) ? String(result.downloadUrl) : '';
    try {
      const replyMarkup = fallbackUrl
        ? Markup.inlineKeyboard([[{
          text: '🎵 Musiqani ochish',
          url: fallbackUrl,
          style: 'success'
        }]]).reply_markup
        : undefined;
      await ctx.reply(
        `Bu musiqani MP3 qilib yuborib bo\'lmadi. Boshqa natijani tanlang.${detail}`,
        replyOptions(replyMarkup)
      );
    } catch (replyError) {
      console.error('FALLBACK_REPLY_ERROR:', replyError);
    }
    return null;
  } finally {
    try {
      await ctx.telegram.deleteMessage(ctx.from.id, status.message_id);
    } catch (cleanupError) {
      console.error('STATUS_MESSAGE_CLEANUP_ERROR:', cleanupError);
    }
    if (music?.tempDir) {
      try {
        await fs.rm(music.tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('MUSIC_FILE_CLEANUP_ERROR:', cleanupError);
      }
    }
  }
  return ctx.reply('✅ Musiqa yuborildi.');
});

function permissionForCallback(callbackData) {
  if (callbackData === 'admin:stats') return 'stats';
  if (callbackData === 'admin:admins' || callbackData === 'admin:add' || callbackData === 'admin:logs' || callbackData.startsWith('admin:manage:') || callbackData.startsWith('admin:perm:') || callbackData.startsWith('admin:remove:')) return 'admins';
  if (callbackData.startsWith('broadcast:')) return 'broadcast';
  if (/^admin:(?:subscription|required_list|subscription_off)/.test(callbackData)) return 'settings';
  return null;
}

bot.hears(/^(?:Admin panel|🛠 Admin panel)$/, (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  activateAdminPanel(ctx);
  return ctx.reply('Admin panel', adminKeyboard(ctx));
});

bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  activateAdminPanel(ctx);
  return ctx.reply('Admin panel', adminKeyboard(ctx));
});

bot.command('music', async (ctx) => {
  const query = String(ctx.message?.text || '')
    .replace(/^\/music(?:@\w+)?\s*/i, '')
    .trim();
  if (!query) {
    ctx.session = { step: 'music_search' };
    return ctx.reply('🎵 Musiqa nomi yoki artistini yuboring:', replyOptions());
  }
  reset(ctx);
  return replyMusicResults(ctx, query);
});

bot.action('admin:stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  return adminStats(ctx);
});

bot.action('admin:panel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  activateAdminPanel(ctx);
  return ctx.reply('Admin panel', adminKeyboard(ctx));
});

bot.action('admin:exit', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  reset(ctx);
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (error) {
    console.warn('Admin panel close failed:', error.response?.description || error.message);
  }
  return ctx.reply('Admin paneldan chiqildi.', userKeyboard(ctx));
});

bot.action('admin:admins', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const admins = await Admin.find({ active: true }).sort({ createdAt: 1 }).lean();
  const text = admins.length
    ? admins.map((admin, index) => `${index + 1}. ${admin.nickname || admin.username || admin.telegramId} - ${permissionsLabel(admin.permissions)}`).join('\n')
    : 'Hali qo\'shimcha adminlar yo\'q.';
  const rows = admins.map((admin) => [Markup.button.callback(
    `⚙️ ${admin.nickname || admin.username || admin.telegramId}`, `admin:manage:${admin.telegramId}`
  )]);
  rows.push([Markup.button.callback('➕ Admin qo\'shish', 'admin:add')]);
  rows.push([Markup.button.callback('⬅️ Admin panel', 'admin:panel')]);
  return ctx.reply(`👥 Adminlar\n\n${text}`, Markup.inlineKeyboard(rows));
});

bot.action('admin:logs', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const logs = await AdminLog.find({}).sort({ createdAt: -1 }).limit(20).lean();
  if (!logs.length) return ctx.reply('Hali admin amallari qayd etilmagan.', adminKeyboard(ctx));
  const text = logs.map((log, index) => {
    const date = new Date(log.createdAt).toLocaleString('uz-UZ', { timeZone: config.timezone });
    return `${index + 1}. ${log.adminName || log.adminTelegramId}\n${log.action}${log.details ? ` - ${log.details}` : ''}\n${date}`;
  }).join('\n\n');
  return ctx.reply(`🧾 Oxirgi admin amallari\n\n${text}`, adminKeyboard(ctx));
});

bot.action('admin:add', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  ctx.session = { step: 'admin_add', adminPanelActive: true };
  return ctx.reply('Qo\'shiladigan adminning Telegram ID raqamini yuboring:');
});

bot.action(/^admin:manage:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const admin = await Admin.findOne({ telegramId: Number(ctx.match[1]), active: true }).lean();
  if (!admin) return ctx.reply('Admin topilmadi.', adminKeyboard(ctx));
  return ctx.reply(
    `Admin: ${admin.nickname || admin.username || admin.telegramId}\nID: ${admin.telegramId}\nHuquqlar: ${permissionsLabel(admin.permissions)}`,
    adminManagementKeyboard(admin)
  );
});

bot.action(/^admin:perm:(\d+):(movies|broadcast|stats|settings|admins)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const telegramId = Number(ctx.match[1]);
  const permission = ctx.match[2];
  const admin = await Admin.findOne({ telegramId, active: true });
  if (!admin) return ctx.reply('Admin topilmadi.', adminKeyboard(ctx));
  admin.permissions = admin.permissions.includes(permission)
    ? admin.permissions.filter((item) => item !== permission)
    : [...admin.permissions, permission];
  await admin.save();
  adminRegistry.set(telegramId, admin.toObject());
  await logAdminAction(ctx, 'admin_permission_changed', `${telegramId}: ${permission}`);
  return ctx.reply(`Huquq yangilandi.\n\nHuquqlar: ${permissionsLabel(admin.permissions)}`, adminManagementKeyboard(admin));
});

bot.action(/^admin:remove:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin bu bo\'limni boshqaradi.');
  const telegramId = Number(ctx.match[1]);
  await Admin.updateOne({ telegramId }, { $set: { active: false } });
  adminRegistry.delete(telegramId);
  await logAdminAction(ctx, 'admin_removed', String(telegramId));
  return ctx.reply('Admin o\'chirildi.', adminKeyboard(ctx));
});

bot.action('admin:broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  ctx.session = { step: 'broadcast_media', broadcast: { buttons: [] }, adminPanelActive: true };
  return ctx.reply('<tg-emoji emoji-id="5350693961281314631">🖼</tg-emoji> Xabar uchun rasm, video yoki GIF yuboring. Media shart emas:', replyOptions(broadcastKeyboard().reply_markup));
});

bot.action('broadcast:no_media', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_media') return ctx.reply('Broadcast jarayoni topilmadi.');
  ctx.session.step = 'broadcast_caption';
  return ctx.reply('<tg-emoji emoji-id="5393314064220843793">💬</tg-emoji> Xabar matnini yuboring. Premium emoji uchun HTML teglaridan foydalanishingiz mumkin:', replyOptions());
});

bot.action('broadcast:add_button', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_buttons') return ctx.reply('Avval xabar matnini kiriting.');
  ctx.session.step = 'broadcast_button_text';
  return ctx.reply('Inline tugma matnini yuboring:');
});

bot.action('broadcast:preview', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_buttons') return ctx.reply('Avval xabarni tayyorlang.');
  return previewBroadcast(ctx);
});

bot.action(/^broadcast:color:(blue|green|red)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_button_color') return ctx.reply('Tugma rangi tanlash bosqichi topilmadi.');
  const style = { blue: 'primary', green: 'success', red: 'danger' }[ctx.match[1]];
  ctx.session.broadcast.buttons.push([{
    text: ctx.session.pendingButtonText,
    url: ctx.session.pendingButtonUrl,
    style
  }]);
  ctx.session.pendingButtonText = undefined;
  ctx.session.pendingButtonUrl = undefined;
  ctx.session.step = 'broadcast_buttons';
  return ctx.reply('Tugma qo\'shildi. Yana tugma qo\'shasizmi?', broadcastButtonKeyboard());
});

bot.action('broadcast:send', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx) || !ctx.session?.broadcast?.previewed) return ctx.reply('Avval Preview tugmasini bosing.');
  const result = await sendBroadcast(ctx);
  await logAdminAction(ctx, 'broadcast_sent', `total=${result.total}, sent=${result.sent}, failed=${result.failed}`);
  reset(ctx);
  return ctx.reply(`Xabar yuborildi.\nJami: ${result.total}\nYetib bordi: ${result.sent}\nBloklagan: ${result.blocked}\nXatolik: ${result.failed}`, adminKeyboard(ctx));
});

bot.action('broadcast:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  reset(ctx);
  return ctx.reply('Xabar yuborish bekor qilindi.', adminKeyboard(ctx));
});

bot.action('admin:subscription', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  ctx.session = { step: 'required_subscription_channel', adminPanelActive: true };
  return ctx.reply('Majburiy obuna kanalining public username sini yuboring, masalan: @my_channel');
});

bot.action('admin:required_list', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const channels = await getRequiredChannels();
  if (!channels.length) return ctx.reply('Majburiy obuna kanallari yo\'q.', adminKeyboard());
  return ctx.reply(channels.map((channel, index) => `${index + 1} - kanal: ${channel.title || channel.username}`).join('\n'), adminKeyboard());
});

bot.action('admin:subscription_off', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  data.settings.requiredChannels = [];
  await saveSettings();
  return ctx.reply('Majburiy obuna o\'chirildi.', adminKeyboard());
});

bot.action('admin:join_requests', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  return ctx.reply('Maxfiy kanalga qo\'shilish sorovlari:', joinRequestKeyboard());
});

bot.action(/^admin:join_mode:(auto|batch)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const mode = ctx.match[1];
  data.settings.joinApprovalMode = mode;
  await saveSettings();
  return ctx.reply(`Qo\'shilish sorovlari rejimi: ${mode === 'auto' ? 'avtomatik qabul' : 'bittada qabul qilish'}`, joinRequestKeyboard());
});

bot.action('admin:approve_pending_joins', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');

  const allQueues = Array.from(joinRequestQueue.entries());
  if (!allQueues.length) return ctx.reply('Hozirda qabul qilish uchun sorovlar yo\'q.', joinRequestKeyboard());

  let totalApproved = 0;
  for (const [chatId, requests] of allQueues) {
    const result = await batchApprovePendingJoinRequests(ctx, chatId);
    totalApproved += result.approved;
  }

  return ctx.reply(`Kutilayotgan ${totalApproved} ta qo\'shilish sorovi qabul qilindi.`, joinRequestKeyboard());
});

bot.on('chat_join_request', async (ctx) => {
  const request = ctx.chatJoinRequest || ctx.update.chat_join_request;
  const chatId = Number(request?.chat?.id || 0);
  const userId = Number(request?.from?.id || 0);
  if (!chatId || !userId) return;

  if ((data.settings.joinApprovalMode || 'auto') === 'batch') {
    const queued = enqueueJoinRequest(chatId, {
      userId,
      username: request.from?.username || '',
      firstName: request.from?.first_name || '',
      date: request.date
    });
    if (queued) {
      console.log(`Join request queued for chat ${chatId} user ${userId}`);
    }
    return;
  }

  const result = await approveChatJoinRequestForBot(ctx, chatId, userId);
  if (!result.approved) {
    console.warn(`Auto-approve failed for chat ${chatId} user ${userId}: ${result.reason}`);
  }
});

bot.on('video', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Musiqa nomi yoki artistini yuboring.');
  if (ctx.session?.step === 'broadcast_media') {
    ctx.session.broadcast.mediaType = 'video';
    ctx.session.broadcast.media = ctx.message.video.file_id;
    ctx.session.step = 'broadcast_caption';
    return ctx.reply('Media uchun izoh yuboring:');
  }
  return ctx.reply('Musiqa nomi yoki artistini yuboring.');
});

bot.on('photo', async (ctx) => {
  if (isAdmin(ctx) && ctx.session?.step === 'broadcast_media') {
    ctx.session.broadcast.mediaType = 'photo';
    ctx.session.broadcast.media = ctx.message.photo.at(-1).file_id;
    ctx.session.step = 'broadcast_caption';
    return ctx.reply('Media uchun izoh yuboring:');
  }
  return ctx.reply('Musiqa nomi yoki artistini yuboring.');
});

bot.on('animation', async (ctx) => {
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_media') return ctx.reply('Musiqa nomi yoki artistini yuboring.');
  ctx.session.broadcast.mediaType = 'animation';
  ctx.session.broadcast.media = ctx.message.animation.file_id;
  ctx.session.step = 'broadcast_caption';
  return ctx.reply('Media uchun izoh yuboring:');
});

bot.on('text', async (ctx) => {
  const rawText = ctx.message.text;
  const value = rawText.trim();
  const step = ctx.session?.step;
  if (value.startsWith('/')) {
    reset(ctx);
    return ctx.reply(isAdmin(ctx) ? 'Bu command mavjud emas. Admin paneldan foydalaning.' : 'Bu command mavjud emas. Musiqa nomi yoki artistini yuboring.');
  }
  if (/^(?:Admin panel|🛠 Admin panel)$/.test(value)) {
    if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
    activateAdminPanel(ctx);
    return ctx.reply('Admin panel', adminKeyboard());
  }
  if (step === 'broadcast_caption') {
    ctx.session.broadcast.caption = rawText;
    ctx.session.broadcast.captionEntities = ctx.message.entities || [];
    ctx.session.step = 'broadcast_buttons';
    return ctx.reply('Inline tugma qo\'shasizmi?', broadcastButtonKeyboard());
  }
  if (step === 'music_search') {
    reset(ctx);
    return replyMusicResults(ctx, value);
  }
  if (step === 'broadcast_button_text') {
    ctx.session.pendingButtonText = value;
    ctx.session.step = 'broadcast_button_url';
    return ctx.reply('Tugma havolasini yuboring (https://...):');
  }
  if (step === 'broadcast_button_url') {
    if (!isHttpUrl(value)) return ctx.reply('Havola http:// yoki https:// bilan boshlanishi kerak. Qayta yuboring:');
    ctx.session.pendingButtonUrl = value;
    ctx.session.step = 'broadcast_button_color';
    return ctx.reply('Tugma rangini tanlang:', broadcastColorKeyboard());
  }
  if (step === 'admin_add') {
    if (!isOwner(ctx)) return ctx.reply('Faqat asosiy admin yangi admin qo\'sha oladi.');
    if (!/^\d+$/.test(value)) return ctx.reply('Telegram ID faqat raqamlardan iborat bo\'lishi kerak:');
    const telegramId = Number(value);
    if (telegramId === ADMIN_TG_ID) return ctx.reply('Asosiy adminni qayta qo\'shib bo\'lmaydi.');
    const admin = await Admin.findOneAndUpdate(
      { telegramId },
      { $set: { active: true }, $setOnInsert: { telegramId, permissions: [] } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean();
    adminRegistry.set(telegramId, admin);
    await logAdminAction(ctx, 'admin_added', String(telegramId));
    reset(ctx);
    return ctx.reply(`Admin qo\'shildi: ${telegramId}. Endi uning huquqlarini belgilang.`, adminKeyboard(ctx));
  }
  if (step === 'required_subscription_channel') {
    try {
      const channel = await checkFullAdmin(ctx, normalizeChannel(value));
      if (!data.settings.requiredChannels.some((item) => item.id === channel.id)) data.settings.requiredChannels.push(channel);
      await saveSettings();
      reset(ctx);
      return ctx.reply(`${channel.title} majburiy obuna kanaliga qo'shildi.`, adminKeyboard());
    } catch (error) {
      return ctx.reply(error.message);
    }
  }
  return ctx.reply(configuredMessage('invalidCode', ctx, { code: value }), replyOptions());
});

bot.on('callback_query', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  reset(ctx);
});

bot.catch(async (error, ctx) => {
  console.error(`Update ${ctx.updateType} failed:`, error.response?.description || error.message);
  await safeAnswerCbQuery(ctx);
  try {
    if (ctx.from?.id) await ctx.telegram.sendMessage(ctx.from.id, '⚠️ Texnik xatolik yuz berdi. Iltimos, qaytadan urinib ko\'ring.', { protect_content: !isAdmin(ctx) });
  } catch (replyError) {
    console.error('Error notification failed:', replyError.response?.description || replyError.message);
  }
});

async function safeAnswerCbQuery(ctx) {
  if (!ctx.callbackQuery) return;
  try { await ctx.answerCbQuery(); } catch {}
}

module.exports = {
  buildYoutubeSearchUrl,
  normalizeYouTubeSearchResult,
  searchMusic,
  downloadMusicMp3,
  formatMusicDuration
};

async function startBot() {
  await hydrateSettings();
  await bot.launch();
  console.log('Music bot ishga tushdi.');
}

if (require.main === module) {
  startBot().catch((error) => {
    console.error('Bot startup failed:', error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', async () => { bot.stop('SIGINT'); await mongoose.disconnect(); });
process.once('SIGTERM', async () => { bot.stop('SIGTERM'); await mongoose.disconnect(); }); 