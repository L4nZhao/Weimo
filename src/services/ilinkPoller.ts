import { config } from "../lib/config.js";
import { listPollableIlinkBots, markIlinkBotPollingError, pollIlinkUpdates } from "./ilinkService.js";

const activePollers = new Map<string, boolean>();
const inFlightPolls = new Set<string>();

export async function startIlinkPoller() {
  if (!config.ilinkAutoPoll) {
    console.log("iLink auto polling disabled.");
    return;
  }

  await ensurePollers();
  setInterval(() => {
    ensurePollers().catch((error) => {
      console.error("Failed to refresh iLink pollers", error);
    });
  }, Math.max(config.ilinkPollRetryMs, 5000));
}

async function ensurePollers() {
  const bots = await listPollableIlinkBots();
  const pollableIds = new Set(bots.map((bot) => bot.id));

  for (const botId of activePollers.keys()) {
    if (!pollableIds.has(botId)) {
      activePollers.delete(botId);
      console.log(`Stopped iLink poller for inactive bot ${botId}.`);
    }
  }

  for (const bot of bots) {
    if (!activePollers.has(bot.id)) {
      activePollers.set(bot.id, true);
      void pollForever(bot.id);
    }
  }
}

async function pollForever(botId: string) {
  while (activePollers.get(botId)) {
    if (inFlightPolls.has(botId)) {
      console.warn(`Skip iLink bot ${botId} polling because previous round is still running.`);
      await sleep(config.ilinkPollRetryMs);
      continue;
    }
    try {
      inFlightPolls.add(botId);
      const result = await pollIlinkUpdates(botId);
      if (result.updatesCount > 0) {
        console.log(
          `iLink bot ${botId} updates=${result.updatesCount} handled=${result.handledCount} skipped=${result.skippedCount}`
        );
      }
    } catch (error) {
      console.error(`iLink bot ${botId} polling failed`, error);
      if (error instanceof Error && error.message === "机器人不存在。") {
        activePollers.delete(botId);
        console.log(`Stopped iLink poller for missing bot ${botId}.`);
        return;
      }
      try {
        await markIlinkBotPollingError(botId, error);
      } catch (markError) {
        console.error(`Failed to store iLink bot ${botId} polling error`, markError);
      }
      await sleep(config.ilinkPollRetryMs);
    } finally {
      inFlightPolls.delete(botId);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 1000)));
}
