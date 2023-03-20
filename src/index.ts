import "https://deno.land/x/dotenv@v3.2.2/load.ts";
import { Bot } from "https://deno.land/x/grammy@v1.15.3/mod.ts";
import { Database, moreThanOrEqual } from 'https://deno.land/x/aloedb@0.9.0/mod.ts'
import * as path from "https://deno.land/std@0.57.0/path/mod.ts";

type UserAlert = {
  telegram_id: string;
  feeAmount: number;
  feeType: 'economyFee'
};

type MempoolApiResponse = {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
};

const settings = {
  BOT_TOKEN: Deno.env.get('BOT_TOKEN')!,
};

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const __dirname = path.dirname(path.fromFileUrl(import.meta.url));

const bot = new Bot(settings.BOT_TOKEN);
const db = new Database<UserAlert>(path.join(__dirname, '..', 'db.json'));
let cached: MempoolApiResponse | undefined = undefined;
let cachedAt: Date | undefined = undefined;

const textPrettier = (text: string) => {
 return text.at(0)?.toUpperCase() + text.slice(1, text.length).split('F').join(' F');
};

const fetchFees = async () => {
  if (cached && cachedAt && new Date().getTime() - cachedAt.getTime() <= 1000 * 60) {
    return cached;
  }

  const response = await fetch('https://mempool.space/api/v1/fees/recommended');
  const data: MempoolApiResponse = await response.json();
  cachedAt = new Date();
  cached = data;
  return data;
}

bot.command("start", async ctx => {
  await ctx.reply('Hi! Welcome to the BitcoinFeesAlert bot.\n\nUse the command /alert X, where X is the Bitcoin fee in vbyte that you want to be notified about (economy fees only, for now).');
});

bot.command("alert", async ctx => {
  const feeAmount = Number(ctx.match);
  if (Number.isNaN(feeAmount) || feeAmount === 0) {
    await ctx.reply('Looks like you gave me an invalid number. Could you try again?\n\nExample: <pre>/alert 5</pre>', { parse_mode: 'HTML' });
    return;
  }
  let userAlert = await db.findOne({ telegram_id: String(ctx.chat.id) });
  if (userAlert) {
    userAlert.feeAmount = feeAmount;
    await db.updateOne({ telegram_id: String(ctx.chat.id) }, userAlert);
  } else {
    userAlert = await db.insertOne({
      telegram_id: String(ctx.chat.id),
      feeType: 'economyFee',
      feeAmount,
    });
  }
  console.log('New alert', userAlert);
  await ctx.reply(`I will let you know when fees go below ${feeAmount} sat/vbyte.`);
})

bot.command("fees", async ctx => {
  const fees = await fetchFees();
  let message = '<b>Current fees:</b>\n\n';
  message += Object.entries(fees).map(([type, value]) => `${textPrettier(type)}: ${value} sats/vbyte`).join('\n');
  await bot.api.sendMessage(ctx.chat.id, message, { parse_mode: 'HTML' });
});

await bot.api.setMyCommands([
  {
    command: '/alert',
    description: 'Use /alert X to get notified when economy fees <= X'
  },
  {
    command: '/fees',
    description: 'What are the fees looking like right now?'
  }
])

bot.start();

while (true) {
  const fees = await fetchFees();
  const alerts = await db.findMany({ feeAmount: moreThanOrEqual(fees.economyFee) });

  const notificationsToSend = alerts.map(async alert => {
    console.log('New notification', alert);
    let message = `Economy fees have dropped below <b>${alert.feeAmount} sats/vbyte</b>!\n\n<b>Current fees:</b>\n\n`;
    message += Object.entries(fees).map(([type, value]) => `${textPrettier(type)}: ${value} sats/vbyte`).join('\n');
    message += '\n\nAlerts have been disabled. Enable then again with <pre>/alert X</pre>.'
    await bot.api.sendMessage(alert.telegram_id, message, { parse_mode: 'HTML' });
    await db.deleteOne(alert);
  });

  const results = await Promise.allSettled(notificationsToSend) as PromiseRejectedResult[];
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length > 0) {
    console.warn(`${failed.length} promises failed, reasons:`, failed.map(failed => failed.reason));
  }
  await sleep(1000 * 60);
}