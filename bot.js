// bot.js faylining eng tepasiga joylashtiring:
const path = require('path');
if (process.platform === 'linux') {
    // Render serverida joriy papkani tizim PATH muhitiga qo'shadi
    process.env.PATH = process.env.PATH + ':' + path.resolve('./');
}

require('dotenv').config();
const config = require('./config');
process.env.TZ = config.timezone;

const mongoose = require('mongoose');
const express = require('express');
const { Telegraf, Markup, session, Input } = require('telegraf');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
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

const movieSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true, index: true },
  title: { type: String, required: true },
  genre: { type: String, required: true },
  language: { type: String, required: true },
  videoFileId: { type: String, required: true },
  promoFileId: { type: String, required: true },
  promoType: { type: String, enum: ['photo', 'video'], required: true },
  views: { type: Number, default: 0 },
  viewDays: { type: mongoose.Schema.Types.Mixed, default: {} },
  promoMessageId: { type: Number, default: null },
  promoChannelId: { type: Number, default: null },
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
const Movie = mongoose.models.Movie || mongoose.model('Movie', movieSchema);
const BotConfig = mongoose.models.BotConfig || mongoose.model('BotConfig', botConfigSchema);
const Session = mongoose.models.BotSession || mongoose.model('BotSession', sessionSchema);
const Broadcast = mongoose.models.Broadcast || mongoose.model('Broadcast', broadcastSchema);
const AdminLog = mongoose.models.AdminLog || mongoose.model('AdminLog', adminLogSchema);

const app = express();
const port = Number(process.env.PORT) || 3000;
app.get('/', (req, res) => res.send('Movie bot ishlamoqda...'));
app.get('/health', (req, res) => res.status(200).json({
  ok: true,
  mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
}));
app.listen(port, '0.0.0.0', () => console.log(`Express server ${port} portda ishlayapti.`));

const bot = new Telegraf(config.botToken);
const ADMIN_USERNAME = config.admin.username;
const ADMIN_TG_ID = config.admin.telegramId;
const adminPermissions = ['movies', 'broadcast', 'stats', 'settings', 'admins'];
const adminRegistry = new Map();
const data = { settings: { requiredChannels: [], movieChannel: null } };
const premiumEmojis = {
  welcome: '<tg-emoji emoji-id="5199785165735367039">⚡️</tg-emoji>',
  bot: '<tg-emoji emoji-id="5323359973365784232">🤖</tg-emoji>',
  confirm: '<tg-emoji emoji-id="5393275607083676065">✔️</tg-emoji>',
  warning: '<tg-emoji emoji-id="5215351548850218245">⚠️</tg-emoji>',
  web: '<tg-emoji emoji-id="5231482153228835967">🌐</tg-emoji>'
};
const defaultMessages = {
  welcome: `${premiumEmojis.welcome} Assalomu alaykum {nickname}\n\n${premiumEmojis.bot} @{bot_username} orqali siz o\'zingizga yoqqan kinoni topishingiz mumkin\n${premiumEmojis.confirm} Shunchaki kino kodini yuboring va kinoni oling`,
  subscriptionRequired: `${premiumEmojis.warning} Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling`,
  invalidCode: '<tg-emoji emoji-id="5212992409213872592">❌</tg-emoji> Kino kodi xato. Boshqa kino kodini yuboring.',
  nonNumericCode: 'Kino kodi faqat raqam bo\'lishi kerak. Qayta yuboring.',
  help: `${premiumEmojis.web} Kino kodini yuboring. Masalan: 1001. Bot sizga shu koddagi kinoni yuboradi.`
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
  const labels = { movies: 'Kinolar', broadcast: 'Xabar yuborish', stats: 'Statistika', settings: 'Sozlamalar', admins: 'Adminlar' };
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
  return `https://www.googleapis.com/youtube/v3/search?${params.toString().replace(/\+/g, '%20')}`;
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kino-music-'));
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
    '-f', 'ba/b', // 'bestaudio' so'zini qisqartirib 'ba/b' qildik, bu eng mos audioni tez topadi
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '5', // Katta K harfi olib tashlandi (5 - tez va sifatli standart)
    '--max-filesize', '48M',
    '--no-warnings',
    '--no-progress',
    '--external-downloader', 'aria2c', // Agar kompyuterda aria2 bo'lsa, yuklashni 10 baravar tezlashtiradi (ixtiyoriy)
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

    const tagResult = NodeID3.write({ title, artist, album: 'KinoManiaBot' }, outputPath);
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

function adminKeyboard() {
  const ctx = arguments[0];
  const can = (permission) => !ctx || hasPermission(ctx, permission);
  const rows = [];
  if (can('stats')) rows.push([
    Markup.button.callback('📊 Statistika', 'admin:stats')
  ]);
  if (can('movies')) rows.push([
    Markup.button.callback('🎬 Kino joylash', 'admin:add_movie'),
    Markup.button.callback('🔎 Kino kodini qidirish', 'admin:find_movie')
  ]);
  if (can('broadcast')) rows.push([
    Markup.button.callback('📣 Xabar yuborish', 'admin:broadcast')
  ]);
  if (can('settings')) rows.push([
    Markup.button.callback('📣 Kino kanalini sozlash', 'admin:movie_channel'),
    Markup.button.callback('📢 Obuna kanalini qo\'shish', 'admin:subscription')
  ]);
  if (can('settings')) rows.push([
    Markup.button.callback('📋 Obuna kanallari', 'admin:required_list'),
    Markup.button.callback('❌ Obunani o\'chirish', 'admin:subscription_off')
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
  const channel = data.settings.movieChannel;
  const rows = [];
  if (channel?.username) rows.push([{
    text: '🎥 Kino kodlari',
    url: `https://t.me/${String(channel.username).replace(/^@/, '')}`,
    style: 'primary'
  }]);
  rows.push([{ text: '🎵 Musiqa qidirish', callback_data: 'music:search', style: 'success' }]);
  rows.push([{ text: '🆕 So\'nggi kinolar', callback_data: 'latest_movies', style: 'danger' }]);
  rows.push([{ text: '❓ Yordam', callback_data: 'help', style: 'success' }]);
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

async function saveSettings() {
  await BotConfig.findOneAndUpdate(
    { configKey: 'main_config' },
    { $set: { channels: data.settings.requiredChannels, settings: { movieChannel: data.settings.movieChannel, messages: data.settings.messages } } },
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
  data.settings.movieChannel = configDocument.settings?.movieChannel || null;
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

function movieCaption(movie, views, includeViews = true) {
  const genre = String(movie.genre || '').trim();
  const language = String(movie.language || '').trim();
  const languageFlag = { "o'zbek": '🇺🇿', uzbek: '🇺🇿', rus: '🇷🇺', russian: '🇷🇺', ingliz: '🇬🇧', english: '🇬🇧' }[language.toLowerCase()] || '';
  return `<b><tg-emoji emoji-id="5375464961822695044">🎬</tg-emoji> ${movie.title}</b>\n\n` +
    `<tg-emoji emoji-id="5375099322666859339">🖥</tg-emoji> Kino kodi: <code>${movie.code}</code>\n` +
    `<tg-emoji emoji-id="5359441070201513074">🎭</tg-emoji> Janri: ${genre.startsWith('#') ? genre : `#${genre}`}\n` +
    `<tg-emoji emoji-id="5188381825701021648">🌐</tg-emoji> Tili: ${language}${languageFlag ? ` ${languageFlag}` : ''}\n` +
    `<tg-emoji emoji-id="4916086774649848789">🔗</tg-emoji> Bot: @${config.botUsername}`;
}

function movieLink(code) {
  return `https://t.me/${config.botUsername}?start=movie_${encodeURIComponent(code)}`;
}


async function sendMovie(ctx, code) {
  const normalizedCode = String(code || '').trim();
  const dayKey = new Date().toISOString().slice(0, 10);
  const movie = await Movie.findOneAndUpdate(
    { code: normalizedCode },
    { $inc: { views: 1, [`viewDays.${dayKey}`]: 1 } },
    { returnDocument: 'after' }
  ).lean();
  if (!movie) return ctx.reply(configuredMessage('invalidCode', ctx, { code: normalizedCode }), replyOptions());
  const channel = data.settings.movieChannel;
  const buttonRows = channel?.username
    ? [[Markup.button.url('🎥 Kino kodlari kanali', `https://t.me/${String(channel.username).replace(/^@/, '')}`)]]
    : [];
  const statusMessage = await ctx.reply('⏳ Kino tayyorlanmoqda...');
  let sentMovie;
  try {
    sentMovie = await ctx.telegram.sendVideo(ctx.from.id, movie.videoFileId, {
      caption: movieCaption(movie, movie.views),
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttonRows).reply_markup,
      protect_content: shouldProtectContent(ctx.from.id)
    });
  } finally {
    try { await ctx.telegram.deleteMessage(ctx.from.id, statusMessage.message_id); } catch {}
  }
  return sentMovie;
}

async function publishMovieAdvertisement(movie, replaceMedia = false) {
  const channel = data.settings.movieChannel;
  if (!channel?.id) throw new Error('Kino reklama kanali sozlanmagan.');
  const replyMarkup = Markup.inlineKeyboard([[Markup.button.url('▶️ Kinoni ko\'rish', movieLink(movie.code))]]).reply_markup;
  const caption = movieCaption(movie, 0, false);
  if (movie.promoChannelId && movie.promoMessageId && !replaceMedia && movie.promoChannelId === channel.id) {
    try {
      return await bot.telegram.editMessageCaption(channel.id, movie.promoMessageId, undefined, caption, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } catch (error) {
      console.warn('Movie advertisement edit failed, replacing it:', error.response?.description || error.message);
    }
  }
  if (movie.promoChannelId && movie.promoMessageId) {
    try {
      await bot.telegram.deleteMessage(movie.promoChannelId, movie.promoMessageId);
    } catch (error) {
      console.warn('Old movie advertisement delete failed:', error.response?.description || error.message);
    }
  }
  const extra = {
    caption,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
    protect_content: true
  };
  const message = movie.promoType === 'photo'
    ? await bot.telegram.sendPhoto(channel.id, movie.promoFileId, extra)
    : await bot.telegram.sendVideo(channel.id, movie.promoFileId, extra);
  await Movie.updateOne(
    { _id: movie._id },
    { $set: { promoChannelId: channel.id, promoMessageId: message.message_id } }
  );
  return message;
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
  const [subscribers, activeUsers, movies, views, popular, broadcasts] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ lastActiveAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
    Movie.countDocuments(),
    Movie.aggregate([{ $group: { _id: null, total: { $sum: '$views' } } }]),
    Movie.find({}, { title: 1, code: 1, views: 1 }).sort({ views: -1 }).limit(5).lean(),
    Broadcast.aggregate([{ $group: { _id: null, total: { $sum: 1 }, sent: { $sum: '$sent' }, failed: { $sum: '$failed' }, blocked: { $sum: '$blocked' } } }])
  ]);
  const popularText = popular.length
    ? popular.map((movie, index) => `${index + 1}. ${movie.title} (${movie.code}) - ${movie.views || 0}`).join('\n')
    : 'Hali kino ko\'rilmagan.';
  const broadcastStats = broadcasts[0] || { total: 0, sent: 0, failed: 0, blocked: 0 };
  return ctx.reply(`<tg-emoji emoji-id="5244825199278311613">📊</tg-emoji> Bot statistikasi\n\n` +
    `<blockquote>Obunachilar: ${subscribers}\nFaol userlar (24 soat): ${activeUsers}\nJoylangan kinolar: ${movies}\nUmumiy ko'rilgan kinolar: ${views[0]?.total || 0}</blockquote>\n\n` +
    `<blockquote>Eng ko'p ko'rilganlar:\n${popularText}</blockquote>\n\n` +
    `<blockquote>Broadcastlar: ${broadcastStats.total}\nYetib borgan: ${broadcastStats.sent}\nBloklagan: ${broadcastStats.blocked}\nXatolik: ${broadcastStats.failed}</blockquote>`,
    replyOptions(adminKeyboard(ctx).reply_markup));
}

function movieAdminKeyboard(code) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Ma\'lumotlarni o\'zgartirish', `admin:edit_movie:${code}`)],
    [Markup.button.callback('🗑 Kinoni o\'chirish', `admin:delete_movie:${code}`)],
    [Markup.button.callback('🛠 Admin panel', 'admin:panel')]
  ]);
}

function movieAdminText(movie) {
  return `${movie.title}\n\n` +
    `Kino kodi: ${movie.code}\n` +
    `Janri: ${movie.genre}\n` +
    `Tili: ${movie.language}\n` +
    `Ko'rilgan: ${movie.views || 0} marta`;
}

function movieEditKeyboard(code) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Nomini o\'zgartirish', `admin:edit_field:title:${code}`)],
    [Markup.button.callback('🔢 Kodini o\'zgartirish', `admin:edit_field:code:${code}`)],
    [Markup.button.callback('🎭 Janrini o\'zgartirish', `admin:edit_field:genre:${code}`)],
    [Markup.button.callback('🌐 Tilini o\'zgartirish', `admin:edit_field:language:${code}`)],
    [Markup.button.callback('🎥 Videosini o\'zgartirish', `admin:edit_field:video:${code}`)],
    [Markup.button.callback('🖼 Reklama mediasini o\'zgartirish', `admin:edit_field:promo:${code}`)],
    [Markup.button.callback('⬅️ Orqaga', `admin:movie:${code}`)]
  ]);
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
  if (payload.startsWith('movie_')) return sendMovie(ctx, payload.slice(6));
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

bot.action('latest_movies', async (ctx) => {
  await ctx.answerCbQuery();
  const movies = await Movie.find({}, { title: 1, code: 1 })
    .sort({ createdAt: -1 }).limit(10).lean();
  if (!movies.length) return ctx.reply('Hali kino joylanmagan.');
  const buttons = movies.map((movie) => [Markup.button.callback(
    `🎬 ${movie.title} (${movie.code})`, `latest:movie:${movie.code}`
  )]);
  return ctx.reply('<tg-emoji emoji-id="5233588456730427459">🆕</tg-emoji> So\'nggi kinolar:', replyOptions(Markup.inlineKeyboard(buttons).reply_markup));
});

bot.action(/^latest:movie:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return sendMovie(ctx, ctx.match[1]);
});

function permissionForCallback(callbackData) {
  if (callbackData === 'admin:stats') return 'stats';
  if (callbackData === 'admin:admins' || callbackData === 'admin:add' || callbackData === 'admin:logs' || callbackData.startsWith('admin:manage:') || callbackData.startsWith('admin:perm:') || callbackData.startsWith('admin:remove:')) return 'admins';
  if (callbackData.startsWith('broadcast:')) return 'broadcast';
  if (/^admin:(?:add_movie|find_movie|movie:|edit_movie:|edit_field:|delete_movie:|delete_confirm:)/.test(callbackData)) return 'movies';
  if (/^admin:(?:movie_channel|subscription|required_list|subscription_off)/.test(callbackData)) return 'settings';
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

bot.command('kino', async (ctx) => {
  const code = String(ctx.message?.text || '')
    .replace(/^\/kino(?:@\w+)?\s*/i, '')
    .trim();
  if (!code) {
    ctx.session = { step: 'movie_search' };
    return ctx.reply('🎬 Kino kodini yuboring (masalan: 1001):', replyOptions());
  }
  if (!/^\d+$/.test(code)) {
    return ctx.reply(configuredMessage('nonNumericCode', ctx, { code }), replyOptions());
  }
  reset(ctx);
  return sendMovie(ctx, code);
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

bot.action('admin:find_movie', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  ctx.session = { step: 'find_movie', adminPanelActive: true };
  return ctx.reply('<tg-emoji emoji-id="5274099962655816924">❗️</tg-emoji> Tahrirlash yoki o\'chirish uchun kino kodini yuboring:', replyOptions());
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

bot.action(/^admin:movie:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const movie = await Movie.findOne({ code: ctx.match[1] }).lean();
  if (!movie) return ctx.reply('Kino topilmadi.', adminKeyboard(ctx));
  return ctx.reply(movieAdminText(movie), movieAdminKeyboard(movie.code));
});

bot.action(/^admin:edit_movie:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const movie = await Movie.findOne({ code: ctx.match[1] }).lean();
  if (!movie) return ctx.reply('Kino topilmadi.', adminKeyboard(ctx));
  return ctx.reply('Qaysi ma\'lumotni o\'zgartirasiz?', movieEditKeyboard(movie.code));
});

bot.action(/^admin:edit_field:(title|code|genre|language|video|promo):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const [, field, code] = ctx.match;
  if (!await Movie.exists({ code })) return ctx.reply('Kino topilmadi.', adminKeyboard(ctx));
  ctx.session = { step: `edit_movie_${field}`, movieCode: code, adminPanelActive: true };
  const prompts = {
    title: 'Yangi kino nomini yuboring:',
    code: 'Yangi kino kodini yuboring:',
    genre: 'Yangi kino janrini yuboring:',
    language: 'Yangi kino tilini yuboring:',
    video: 'Yangi kino videosini yuboring:',
    promo: 'Yangi reklama videosi yoki rasmini yuboring:'
  };
  return ctx.reply(prompts[field]);
});

bot.action(/^admin:delete_movie:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const movie = await Movie.findOne({ code: ctx.match[1] }).lean();
  if (!movie) return ctx.reply('Kino topilmadi.', adminKeyboard(ctx));
  return ctx.reply(`${movie.title} filmini o\'chirishni tasdiqlaysizmi?`, Markup.inlineKeyboard([
    [Markup.button.callback('✅ Ha, o\'chirish', `admin:delete_confirm:${movie.code}`)],
    [Markup.button.callback('❌ Bekor qilish', `admin:movie:${movie.code}`)]
  ]));
});

bot.action(/^admin:delete_confirm:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  const result = await Movie.deleteOne({ code: ctx.match[1] });
  if (result.deletedCount) await logAdminAction(ctx, 'movie_deleted', ctx.match[1]);
  reset(ctx);
  return ctx.reply(result.deletedCount ? 'Kino o\'chirildi.' : 'Kino topilmadi.', adminKeyboard(ctx));
});

bot.action('admin:movie_channel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  ctx.session = { step: 'movie_channel', adminPanelActive: true };
  return ctx.reply('<tg-emoji emoji-id="5352629724516458059">✈️</tg-emoji> Kino reklamasi tashlanadigan kanal username sini yuboring, masalan: @kino_kanal', replyOptions());
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

bot.action('admin:add_movie', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('Ruxsat yo\'q.');
  if (!data.settings.movieChannel) return ctx.reply('Avval kino reklama kanalini qo\'shing va botni unga admin qiling.', adminKeyboard());
  ctx.session = { step: 'movie_title', adminPanelActive: true };
  return ctx.reply('<tg-emoji emoji-id="5375464961822695044">🎬</tg-emoji> Kino nomini yuboring:', replyOptions());
});

bot.on('video', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Kino kodini yuboring.');
  if (ctx.session?.step === 'broadcast_media') {
    ctx.session.broadcast.mediaType = 'video';
    ctx.session.broadcast.media = ctx.message.video.file_id;
    ctx.session.step = 'broadcast_caption';
    return ctx.reply('Media uchun izoh yuboring:');
  }
  if (ctx.session?.step === 'edit_movie_video') {
    const movie = await Movie.findOneAndUpdate(
      { code: ctx.session.movieCode },
      { $set: { videoFileId: ctx.message.video.file_id } },
      { returnDocument: 'after' }
    ).lean();
    if (movie) await logAdminAction(ctx, 'movie_video_updated', movie.code);
    reset(ctx);
    return ctx.reply(movie ? 'Kino videosi yangilandi.' : 'Kino topilmadi.', movie ? movieAdminKeyboard(movie.code) : adminKeyboard());
  }
  if (ctx.session?.step === 'edit_movie_promo') {
    const movie = await Movie.findOneAndUpdate(
      { code: ctx.session.movieCode },
      { $set: { promoFileId: ctx.message.video.file_id, promoType: 'video' } },
      { returnDocument: 'after' }
    ).lean();
    if (movie) await publishMovieAdvertisement(movie, true);
    if (movie) await logAdminAction(ctx, 'movie_promo_updated', movie.code);
    reset(ctx);
    return ctx.reply(movie ? 'Reklama media si yangilandi va kanalga yuborildi.' : 'Kino topilmadi.', movie ? movieAdminKeyboard(movie.code) : adminKeyboard());
  }
  if (ctx.session?.step === 'movie_video') {
    ctx.session.movie.videoFileId = ctx.message.video.file_id;
    ctx.session.step = 'movie_promo';
    return ctx.reply('Kino uchun qisqa video yoki rasm yuboring:');
  }
  if (ctx.session?.step === 'movie_promo') {
    ctx.session.movie.promoFileId = ctx.message.video.file_id;
    ctx.session.movie.promoType = 'video';
    return finishMovieCreation(ctx);
  }
  return ctx.reply('Kino kodini yuboring.');
});

bot.on('photo', async (ctx) => {
  if (isAdmin(ctx) && ctx.session?.step === 'broadcast_media') {
    ctx.session.broadcast.mediaType = 'photo';
    ctx.session.broadcast.media = ctx.message.photo.at(-1).file_id;
    ctx.session.step = 'broadcast_caption';
    return ctx.reply('Media uchun izoh yuboring:');
  }
  if (isAdmin(ctx) && ctx.session?.step === 'edit_movie_promo') {
    const movie = await Movie.findOneAndUpdate(
      { code: ctx.session.movieCode },
      { $set: { promoFileId: ctx.message.photo.at(-1).file_id, promoType: 'photo' } },
      { returnDocument: 'after' }
    ).lean();
    if (movie) await publishMovieAdvertisement(movie, true);
    if (movie) await logAdminAction(ctx, 'movie_promo_updated', movie.code);
    reset(ctx);
    return ctx.reply(movie ? 'Reklama media si yangilandi va kanalga yuborildi.' : 'Kino topilmadi.', movie ? movieAdminKeyboard(movie.code) : adminKeyboard());
  }
  if (!isAdmin(ctx) || ctx.session?.step !== 'movie_promo') return ctx.reply('Kino kodini yuboring.');
  ctx.session.movie.promoFileId = ctx.message.photo.at(-1).file_id;
  ctx.session.movie.promoType = 'photo';
  return finishMovieCreation(ctx);
});

bot.on('animation', async (ctx) => {
  if (!isAdmin(ctx) || ctx.session?.step !== 'broadcast_media') return ctx.reply('Kino kodini yuboring.');
  ctx.session.broadcast.mediaType = 'animation';
  ctx.session.broadcast.media = ctx.message.animation.file_id;
  ctx.session.step = 'broadcast_caption';
  return ctx.reply('Media uchun izoh yuboring:');
});

async function finishMovieCreation(ctx) {
  const movie = await Movie.create(ctx.session.movie);
  await publishMovieAdvertisement(movie);
  await logAdminAction(ctx, 'movie_created', `${movie.code}: ${movie.title}`);
  reset(ctx);
  return ctx.reply(`Kino joylandi va ${data.settings.movieChannel.username} kanaliga reklama yuborildi.`, adminKeyboard(ctx));
}

bot.on('text', async (ctx) => {
  const rawText = ctx.message.text;
  const value = rawText.trim();
  const step = ctx.session?.step;
  if (value.startsWith('/')) {
    reset(ctx);
    return ctx.reply(isAdmin(ctx) ? 'Bu command mavjud emas. Admin paneldan foydalaning.' : 'Bu command mavjud emas. Kino kodini yuboring.');
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
  if (step === 'movie_search') {
    if (!/^\d+$/.test(value)) return ctx.reply(configuredMessage('nonNumericCode', ctx, { code: value }), replyOptions());
    reset(ctx);
    return sendMovie(ctx, value);
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
  if (step === 'find_movie') {
    if (!/^\d+$/.test(value)) return ctx.reply(configuredMessage('nonNumericCode', ctx, { code: value }), replyOptions());
    const movie = await Movie.findOne({ code: value }).lean();
    if (!movie) return ctx.reply('Kino topilmadi. Boshqa kod yuboring:', adminKeyboard());
    reset(ctx);
    return ctx.reply(movieAdminText(movie), movieAdminKeyboard(movie.code));
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
  if (/^edit_movie_(title|code|genre|language)$/.test(step || '')) {
    const field = step.slice('edit_movie_'.length);
    if (field === 'code') {
      if (!/^\d+$/.test(value)) return ctx.reply('Kino kodi faqat raqam bo\'lishi kerak:');
      if (value !== ctx.session.movieCode && await Movie.exists({ code: value })) return ctx.reply('Bu kino kodi band. Boshqa kod yuboring:');
    }
    const movie = await Movie.findOneAndUpdate(
      { code: ctx.session.movieCode },
      { $set: { [field]: value } },
      { returnDocument: 'after' }
    ).lean();
    if (movie) await publishMovieAdvertisement(movie);
    if (movie) await logAdminAction(ctx, 'movie_updated', `${movie.code}: ${field}`);
    reset(ctx);
    return ctx.reply(movie ? 'Kino ma\'lumoti yangilandi.' : 'Kino topilmadi.', movie ? movieAdminKeyboard(movie.code) : adminKeyboard());
  }
  if (step === 'movie_channel') {
    try {
      data.settings.movieChannel = await checkFullAdmin(ctx, normalizeChannel(value));
      await saveSettings();
      reset(ctx);
      return ctx.reply(`Kino reklama kanali ${data.settings.movieChannel.username} qilib saqlandi.`, adminKeyboard());
    } catch (error) {
      return ctx.reply(error.message);
    }
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
  if (step === 'movie_title') {
    ctx.session.movie = { title: value };
    ctx.session.step = 'movie_code';
    return ctx.reply('Kino kodini yuboring (masalan: 1001):');
  }
  if (step === 'movie_code') {
    if (!/^\d+$/.test(value)) {
      return ctx.reply('⚠️ Kino kodi faqat raqamlardan iborat bo\'lishi kerak. Masalan: 1001. Qayta yuboring:');
    }
    if (await Movie.exists({ code: value })) return ctx.reply('⚠️ Bu kino kodi band. Boshqa kod yuboring:');
    ctx.session.movie.code = value;
    ctx.session.step = 'movie_genre';
    return ctx.reply('Kino janrini yuboring:');
  }
  if (step === 'movie_genre') {
    ctx.session.movie.genre = value;
    ctx.session.step = 'movie_language';
    return ctx.reply('Kino tilini yuboring:');
  }
  if (step === 'movie_language') {
    ctx.session.movie.language = value;
    ctx.session.step = 'movie_video';
    return ctx.reply('Kino videosini yuboring:');
  }
  if (/^\d+$/.test(value)) {
    if (isAdminPanelActive(ctx)) {
      const movie = await Movie.findOne({ code: value }).lean();
      if (!movie) return ctx.reply('Kino topilmadi. Boshqa kod yuboring:', adminKeyboard());
      return ctx.reply(movieAdminText(movie), movieAdminKeyboard(movie.code));
    }
    return sendMovie(ctx, value);
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
  console.log('Movie bot ishga tushdi.');
}

if (require.main === module) {
  startBot().catch((error) => {
    console.error('Bot startup failed:', error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', async () => { bot.stop('SIGINT'); await mongoose.disconnect(); });
process.once('SIGTERM', async () => { bot.stop('SIGTERM'); await mongoose.disconnect(); });