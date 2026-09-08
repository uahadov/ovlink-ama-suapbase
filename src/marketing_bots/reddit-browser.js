require('dotenv').config();
const path = require('path');
const fs = require('fs');

let puppeteer = null;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  try {
    puppeteer = require(path.join(__dirname, '../../node_modules/puppeteer-core'));
  } catch (err) {
    console.warn('[Reddit Browser] puppeteer-core not found.');
  }
}

class RedditBrowserManager {
  constructor() {
    this.limitFile = path.join(__dirname, '../../bot_data/reddit_daily_limit.json');
    this.profileDir = path.join(__dirname, '../../bot_data/chrome_reddit_profile');
    this.chromePath = this.detectChromePath();
    this.maxDaily = parseInt(process.env.REDDIT_DAILY_LIMIT, 10) || 5;
  }

  detectChromePath() {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  getTodayString() {
    return new Date().toISOString().split('T')[0];
  }

  getDailyStatus() {
    const today = this.getTodayString();
    let data = { date: today, count: 0, maxPerDay: this.maxDaily, history: [] };

    try {
      if (fs.existsSync(this.limitFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.limitFile, 'utf8'));
        if (parsed.date === today) {
          data = parsed;
          data.maxPerDay = this.maxDaily;
        } else {
          data = { date: today, count: 0, maxPerDay: this.maxDaily, history: [] };
          this.saveDailyStatus(data);
        }
      }
    } catch (err) {
      console.warn('[Reddit Browser] Error reading daily limit file:', err.message);
    }

    return {
      date: data.date,
      count: data.count || 0,
      maxPerDay: this.maxDaily,
      remaining: Math.max(0, this.maxDaily - (data.count || 0)),
      canPost: (data.count || 0) < this.maxDaily
    };
  }

  saveDailyStatus(data) {
    try {
      const dir = path.dirname(this.limitFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.limitFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Reddit Browser] Error saving daily limit file:', err.message);
    }
  }

  incrementDailyCount(postUrl, commentSnippet) {
    const today = this.getTodayString();
    let data = { date: today, count: 0, maxPerDay: this.maxDaily, history: [] };

    try {
      if (fs.existsSync(this.limitFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.limitFile, 'utf8'));
        if (parsed.date === today) data = parsed;
      }
    } catch (e) {}

    data.count = (data.count || 0) + 1;
    data.history = Array.isArray(data.history) ? data.history : [];
    data.history.push({
      time: new Date().toISOString(),
      url: postUrl,
      snippet: (commentSnippet || '').slice(0, 100)
    });
    this.saveDailyStatus(data);
    return data.count;
  }

  /**
   * Posts a comment to a Reddit post using authentic Chrome browser automation
   */
  async postComment(targetUrl, commentText) {
    const status = this.getDailyStatus();
    if (!status.canPost) {
      throw new Error(`Gündəlik limit (${status.count}/${status.maxPerDay}) tamamlanıb. Reddit anti-spam qorunması üçün bu gün daha rəy göndərilməyəcək.`);
    }

    if (!puppeteer) {
      throw new Error('puppeteer-core quraşdırılmayıb.');
    }

    if (!this.chromePath) {
      throw new Error('Sistemdə Google Chrome və ya Edge brauzeri tapılmadı.');
    }

    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
    }

    let browser = null;
    try {
      browser = await puppeteer.launch({
        executablePath: this.chromePath,
        headless: true,
        userDataDir: this.profileDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,800'
        ]
      });

      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      console.log(`[Reddit Browser] Navigating to ${targetUrl}...`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      const isOldReddit = targetUrl.includes('old.reddit.com');
      let posted = false;

      if (isOldReddit) {
        const textarea = await page.$('form.usertext textarea[name="text"]');
        if (textarea) {
          await textarea.click();
          await page.keyboard.type(commentText, { delay: 40 });
          const saveBtn = await page.$('form.usertext button.save');
          if (saveBtn) {
            await saveBtn.click();
            await new Promise(r => setTimeout(r, 4000));
            posted = true;
          }
        }
      } else {
        const composerSelector = 'shred-comment-composer, faceplate-textarea-input, [slot="rte"], textarea[name="comment"]';
        const composer = await page.$(composerSelector);
        if (composer) {
          await composer.click();
          await page.keyboard.type(commentText, { delay: 40 });
          await new Promise(r => setTimeout(r, 1000));
          const commentBtn = await page.$('button[type="submit"]:not([disabled]), faceplate-form button[type="submit"]');
          if (commentBtn) {
            await commentBtn.click();
            await new Promise(r => setTimeout(r, 4000));
            posted = true;
          }
        }
      }

      if (!posted) {
        const oldUrl = targetUrl.replace('www.reddit.com', 'old.reddit.com').replace('sh.reddit.com', 'old.reddit.com');
        console.log(`[Reddit Browser] Retrying on old.reddit: ${oldUrl}`);
        await page.goto(oldUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 2000));

        const textarea = await page.$('form.usertext textarea[name="text"]');
        if (textarea) {
          await textarea.click();
          await page.keyboard.type(commentText, { delay: 40 });
          const saveBtn = await page.$('form.usertext button.save');
          if (saveBtn) {
            await saveBtn.click();
            await new Promise(r => setTimeout(r, 4000));
            posted = true;
          }
        }
      }

      const newCount = this.incrementDailyCount(targetUrl, commentText);
      return {
        success: true,
        postedToday: newCount,
        maxPerDay: this.maxDaily,
        remainingToday: Math.max(0, this.maxDaily - newCount),
        url: targetUrl
      };
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (e) {}
      }
    }
  }
}

module.exports = new RedditBrowserManager();
