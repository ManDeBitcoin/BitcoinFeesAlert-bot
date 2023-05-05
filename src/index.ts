import "https://deno.land/x/dotenv@v3.2.2/load.ts";
import { Bot } from "https://deno.land/x/grammy@v1.15.3/mod.ts";
import { Database, moreThanOrEqual } from 'https://deno.land/x/aloedb@0.9.0/mod.ts'
import * as path from "https://deno.land/std@0.57.0/path/mod.ts";

type UserAlert = {
  telegram_id: string;
  feeAmount: number;
  feeType: 'economyFee'
};

type Transaction = {
  txId: string
  telegram_id: string
  confirmed: boolean
}

type MempoolApiResponse = {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
};

type TransactionApiResponse = {
  status: {
    confirmed: boolean;
    block_height?: number;
  }
}

const settings = {
  BOT_TOKEN: Deno.env.get('BOT_TOKEN')!,
};

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

const __dirname = path.dirname(path.fromFileUrl(import.meta.url));

const bot = new Bot(settings.BOT_TOKEN);
const Alerts = new Database<UserAlert>(path.join(__dirname, '..', 'db.json'));
const Transactions = new Database<Transaction>(path.join(__dirname, '..', 'db_txs.json'));
let cached: MempoolApiResponse | undefined = undefined;
let cachedAt: Date | undefined = undefined;

const textPrettier = (text: string) => {
 return text.at(0)?.toUpperCase() + text.slice(1, text.length).split('F').join(' F');
};

const fetchTransaction = async (txId: string): Promise<TransactionApiResponse | undefined> => {
  const response = await fetch('https://mempool.space/api/tx/' + txId);
  if (response.status === 200) {
    const data: TransactionApiResponse = await response.json();
    return data;
  }
  return undefined;
}

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
  let message = 'Hi! Welcome to the Bitcoin Fees Alert bot.\n\n'
  message += 'Use the command /alert X, where X is the Bitcoin fee in vbyte that you want to be notified about ("hour fees" only, for now).\n\n'
  message += 'You can also use /tx XXXX, where XXXX is the id of the transaction you want to get notified about when its confirmed.\n'
  message += 'Or use /fees to get current fees.'
  await ctx.reply(message);
});

bot.command("alert", async ctx => {
  const feeAmount = Number(ctx.match);
  if (Number.isNaN(feeAmount) || feeAmount === 0) {
    await ctx.reply('Looks like you gave me an invalid number. Could you try again?\n\nExample: <pre>/alert 5</pre>', { parse_mode: 'HTML' });
    return;
  }
  let userAlert = await Alerts.findOne({ telegram_id: String(ctx.chat.id) });
  if (userAlert) {
    userAlert.feeAmount = feeAmount;
    await Alerts.updateOne({ telegram_id: String(ctx.chat.id) }, userAlert);
  } else {
    userAlert = await Alerts.insertOne({
      telegram_id: String(ctx.chat.id),
      feeType: 'hourFee',
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

bot.command(['tx', 'transaction'], async ctx => {
  const txId = ctx.match;
  if (!txId) {
    await ctx.reply('Missing tx id... try again.');
    return;
  }
  if (txId.length <= 50) {
    await ctx.reply('Tx id looks invalid... try again.');
    return;
  }
  const transaction = await fetchTransaction(txId);
  if (!transaction) {
    await ctx.reply('Could not fetch tx data. Are you sure it is valid?');
    return;
  }
  if (transaction.status.confirmed) {
    await ctx.reply('Transaction already confirmed!\n\n' + 'https://mempool.space/tx/' + txId);
    return;
  }
  let tx = await Transactions.findOne({ telegram_id: String(ctx.chat.id), txId });
  if (tx) {
    await ctx.reply('You are already tracking this transaction.');
    return;
  }
  tx = await Transactions.insertOne({
    telegram_id: String(ctx.chat.id),
    txId,
    confirmed: false,
  })
  console.log('New transaction', tx);
  await ctx.reply(`I will let you know when your transaction gets confirmed!\n\n` + 'https://mempool.space/tx/' + txId);
})

bot.start();

const checkFeesJob = async () => {
  const fees = await fetchFees();
  const alerts = await Alerts.findMany({ feeAmount: moreThanOrEqual(fees.hourFee) });

  const feesNotificationsToSend = alerts.map(async alert => {
    console.log('New notification', alert);
    let message = `Hour fees have dropped below <b>${alert.feeAmount} sats/vbyte</b>!\n\n<b>Current fees:</b>\n\n`;
    message += Object.entries(fees).map(([type, value]) => `${textPrettier(type)}: ${value} sats/vbyte`).join('\n');
    message += '\n\nAlerts have been disabled. Enable then again with <pre>/alert X</pre>.'
    await bot.api.sendMessage(alert.telegram_id, message, { parse_mode: 'HTML' });
    await Alerts.deleteOne(alert);
  });

  const results = await Promise.allSettled(feesNotificationsToSend) as PromiseRejectedResult[];
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length > 0) {
    console.warn(`${failed.length} promises failed, reasons:`, failed.map(failed => failed.reason));
  }
}

const checkTransactionsJob = async () => {
  const unconfirmedTransactions = await Transactions.findMany({ confirmed: false });
  for await (const unconfirmedTransaction of unconfirmedTransactions) {
    const transaction = await fetchTransaction(unconfirmedTransaction.txId);
    if (transaction && transaction.status.confirmed) {
      const message = `Your tx has been <b>confirmed</b> on block <b>${transaction.status.block_height}</b>!\n\n` + 'https://mempool.space/tx/' + unconfirmedTransaction.txId;
      await bot.api.sendMessage(unconfirmedTransaction.telegram_id, message, { parse_mode: 'HTML' });
      await Transactions.updateOne(unconfirmedTransaction, { confirmed: true });
    }
    await sleep(1000 * 3);
  }
}

const runJobInterval = async (fn: () => Promise<void>, ms: number) => {
  await fn().catch();
  setTimeout(async () => { await runJobInterval(fn, ms) }, ms);
}

runJobInterval(checkFeesJob, 1000 * 60 * 1);
runJobInterval(checkTransactionsJob, 1000 * 60 * 5);