const fs = require('fs');
const assert = require('assert');

const source = fs.readFileSync('bot.js', 'utf8');

assert.strictEqual(
  source.includes("const userMember = await ctx.telegram.getChatMember(chat.id, ctx.from.id);") &&
  source.includes("['creator', 'administrator'].includes(userMember.status)") &&
  source.includes("return { id: chat.id, title: chat.title || username, username: chat.username ? `@${chat.username}` : username };"),
  true,
  'checkFullAdmin must require the user who is adding the channel to be a channel creator or administrator.'
);


