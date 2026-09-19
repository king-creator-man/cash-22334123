import { chromium } from "playwright";

const TARGET_URL = process.env.TARGET_URL;
const MAX_RUNTIME_MINUTES = Number(process.env.MAX_RUNTIME_MINUTES || 350);
const EXTRA_WAIT_SECONDS = Number(process.env.EXTRA_WAIT_SECONDS || 5);

const APIFY_PROXY_HOST = process.env.APIFY_PROXY_HOST || "proxy.apify.com";
const APIFY_PROXY_PORT = process.env.APIFY_PROXY_PORT || "8000";
const APIFY_PROXY_USERNAME = process.env.APIFY_PROXY_USERNAME || "auto";
const APIFY_PROXY_PASSWORD = process.env.APIFY_PROXY_PASSWORD;

if (!TARGET_URL) {
  throw new Error("TARGET_URL is required.");
}

if (!APIFY_PROXY_PASSWORD) {
  throw new Error("APIFY_PROXY_PASSWORD is required.");
}

const startTime = Date.now();
const maxRuntimeMs = MAX_RUNTIME_MINUTES * 60 * 1000;

let cycle = 0;

function remainingTime() {
  return maxRuntimeMs - (Date.now() - startTime);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCurrentIp(page) {
  try {
    const response = await page.goto(
      "https://api.apify.com/v2/browser-info/",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000
      }
    );

    if (!response) {
      return "unknown";
    }

    const body = await response.text();

    try {
      const data = JSON.parse(body);

      return (
        data.clientIp ||
        data.client_ip ||
        data.ip ||
        JSON.stringify(data)
      );
    } catch {
      return body.substring(0, 500);
    }
  } catch (error) {
    console.log(`Could not determine proxy IP: ${error.message}`);
    return "unknown";
  }
}

async function runBrowser() {
  cycle++;

  console.log("");
  console.log("==========================================");
  console.log(`Starting browser cycle #${cycle}`);
  console.log(`Target: ${TARGET_URL}`);
  console.log("==========================================");

  let browser;

  try {
    /*
     * IMPORTANT:
     *
     * A new Browser is created for every cycle.
     * Apify Proxy assigns browser connections through its proxy pool.
     */
    browser = await chromium.launch({
      headless: true,

      proxy: {
        server: `http://${APIFY_PROXY_HOST}:${APIFY_PROXY_PORT}`,
        username: APIFY_PROXY_USERNAME,
        password: APIFY_PROXY_PASSWORD
      },

      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const context = await browser.newContext({
      viewport: {
        width: 1366,
        height: 768
      },

      ignoreHTTPSErrors: false
    });

    const page = await context.newPage();

    page.on("console", message => {
      if (message.type() === "error") {
        console.log(`[PAGE ERROR] ${message.text()}`);
      }
    });

    page.on("pageerror", error => {
      console.log(`[PAGE JS ERROR] ${error.message}`);
    });

    console.log("Checking current public IP...");

    const ip = await getCurrentIp(page);

    console.log(`Current proxy IP: ${ip}`);

    /*
     * Now open the actual target.
     */
    console.log(`Opening target page...`);

    const navigationStart = Date.now();

    try {
      await page.goto(TARGET_URL, {
        waitUntil: "load",
        timeout: 120000
      });

      console.log(
        `Page "load" event completed in ${
          ((Date.now() - navigationStart) / 1000).toFixed(1)
        } seconds`
      );
    } catch (error) {
      console.log(`Navigation warning: ${error.message}`);

      /*
       * Even if some resources keep the navigation open,
       * continue with the page if Chromium is still alive.
       */
    }

    /*
     * Give JavaScript/AJAX/fetch requests some time to settle.
     *
     * Some websites never reach networkidle because they have
     * analytics, WebSockets, polling, etc.
     */
    try {
      await page.waitForLoadState("networkidle", {
        timeout: 30000
      });

      console.log("Network became idle.");
    } catch {
      console.log(
        "Network did not become idle within 30 seconds; continuing."
      );
    }

    /*
     * Additional settling time.
     */
    console.log(
      `Waiting ${EXTRA_WAIT_SECONDS} seconds for final page activity...`
    );

    await page.waitForTimeout(EXTRA_WAIT_SECONDS * 1000);

    /*
     * Log final page information.
     */
    console.log(`Final URL: ${page.url()}`);

    try {
      console.log(`Page title: ${await page.title()}`);
    } catch {
      console.log("Could not read page title.");
    }

    console.log(`Cycle #${cycle} completed.`);

    await context.close();
  } catch (error) {
    console.error(`Cycle #${cycle} failed:`);
    console.error(error);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.log(`Browser close warning: ${error.message}`);
      }
    }
  }
}

async function main() {
  console.log("==========================================");
  console.log("GitHub Browser Worker");
  console.log("==========================================");
  console.log(`Target URL: ${TARGET_URL}`);
  console.log(`Maximum runtime: ${MAX_RUNTIME_MINUTES} minutes`);
  console.log(`Extra wait: ${EXTRA_WAIT_SECONDS} seconds`);
  console.log("==========================================");

  while (remainingTime() > 60 * 1000) {
    await runBrowser();

    const remaining = remainingTime();

    console.log("");
    console.log(
      `Remaining runtime: ${(remaining / 60000).toFixed(2)} minutes`
    );

    /*
     * Small pause between browser instances.
     */
    if (remaining > 30 * 1000) {
      await sleep(3000);
    }
  }

  console.log("");
  console.log("==========================================");
  console.log("Maximum runtime reached.");
  console.log(`Total browser cycles: ${cycle}`);
  console.log("Worker finished.");
  console.log("==========================================");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
