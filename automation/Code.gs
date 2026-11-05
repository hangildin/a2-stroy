/**
 * AI WEB FACTORY: free Google Apps Script outbound mailer.
 * Source: the EXISTING hangildin/a2-stroy repository.
 * Requires one-time authorization in user's Gmail account.
 * Safe default: customer sending is DISABLED; this file creates NO triggers.
 *
 * Script Properties (private to the Google Apps Script project):
 *   AWF_LIVE_MODE = ENABLED    (ONLY after the owner explicitly approves live rollout)
 *   AWF_LEADS_JSON = [{"company":"...","email":"...","before":"https://...","after":"https://hangildin.github.io/a2-stroy/demo/.../"}]
 *   AWF_STOPLIST_JSON = ["blocked@example.com"]   (optional)
 *
 * DO NOT commit actual leads, SMTP credentials, API tokens or private log exports
 * to the public GitHub repository.
 */

var AWF_CONFIG = Object.freeze({
  ownerEmail: "hangildin@gmail.com",
  demoRoot: "https://hangildin.github.io/a2-stroy/demo/",
  maxPerRun: 1,
  maxPerDay: 5,
  minMinutesBetweenSends: 60,
  version: "1.0.0"
});

function awfRunApprovedBatch() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {status: "LOCKED", sent: 0};
  try {
    var props = PropertiesService.getScriptProperties();
    var actor = String(Session.getEffectiveUser().getEmail() || "").trim().toLowerCase();
    if (actor !== AWF_CONFIG.ownerEmail) throw new Error("Wrong Gmail account: stop.");
    if (props.getProperty("AWF_LIVE_MODE") !== "ENABLED") {
      return {status: "DISABLED", sent: 0, note: "No customer sends allowed."};
    }

    var leads = JSON.parse(props.getProperty("AWF_LEADS_JSON") || "[]");
    if (!Array.isArray(leads)) throw new Error("AWF_LEADS_JSON must be an array.");
    var stoplist = JSON.parse(props.getProperty("AWF_STOPLIST_JSON") || "[]");
    if (!Array.isArray(stoplist)) throw new Error("AWF_STOPLIST_JSON must be an array.");
    var stop = {};
    stoplist.forEach(function(x) { stop[awfEmail_(x)] = true; });

    var now = new Date();
    var tz = Session.getScriptTimeZone() || "Europe/Moscow";
    var dateStr = Utilities.formatDate(now, tz, "yyyyMMdd");
    var dayKey = "AWF_DAY_" + dateStr;
    var dayCount = Number(props.getProperty(dayKey) || "0");
    var lastSendAt = Number(props.getProperty("AWF_LAST_SEND_MS") || "0");
    var gapMs = AWF_CONFIG.minMinutesBetweenSends * 60000;
    if (dayCount >= AWF_CONFIG.maxPerDay) return {status: "DAILY_LIMIT", sent: 0, today: dayCount};
    if (lastSendAt && now.getTime() - lastSendAt < gapMs)
      return {status: "INTERVAL_LIMIT", sent: 0, today: dayCount};

    var attempts = 0, sent = 0, skipped = 0, errors = 0;
    var seenThisBatch = {};
    for (var i = 0; i < leads.length; i++) {
      if (sent >= AWF_CONFIG.maxPerRun || dayCount >= AWF_CONFIG.maxPerDay) break;
      var lead = leads[i];
      var email = awfEmail_(lead && lead.email);
      var fingerprint = awfHash_(email);
      if (seenThisBatch[email]) {skipped++; continue;}
      seenThisBatch[email] = true;
      if (!awfValidLead_(lead)) {skipped++; continue;}
      if (stop[email] || email === AWF_CONFIG.ownerEmail || awfBlockedCompany_(lead.company)) {skipped++; continue;}
      if (props.getProperty("AWF_SENT_" + fingerprint)) {skipped++; continue;}
      if (props.getProperty("AWF_EXCLUDE_" + fingerprint)) {skipped++; continue;}

      // Gmail itself is the canonical record. Blocks emails sent manually BEFORE this script existed.
      // Never depend on our journal alone for deduplication.
      if (GmailApp.search("in:sent to:" + email, 0, 1).length) {
        props.setProperty("AWF_EXCLUDE_" + fingerprint, "Prior Gmail SENT match");
        awfJournal_(props, lead, "SKIPPED_ALREADY_SENT", "");
        skipped++;
        continue;
      }
      // Check demo link live immediately before sending, not just whether a GitHub file exists.
      if (!awfUrlWorks_(lead.after)) {
        awfJournal_(props, lead, "SKIPPED_DEMO_UNAVAILABLE", "");
        skipped++;
        continue;
      }

      var subject = String(lead.company).trim() + " — подготовили новый сайт за 5 000 ₽";
      var body = awfApprovedTemplate_(lead);
      attempts++;
      try {
        GmailApp.sendEmail(email, subject, body);
        var sentAt = new Date();
        // Persist immediately after send; Gmail SENT lookup is the secondary idempotency barrier.
        props.setProperties({
          ["AWF_SENT_" + fingerprint]: JSON.stringify({email: email, company: String(lead.company), at: sentAt.toISOString()}),
          ["AWF_LAST_SEND_MS"]: String(sentAt.getTime()),
          [dayKey]: String(++dayCount)
        });
        awfJournal_(props, lead, "SENT", subject);
        sent++;
      } catch (err) {
        awfJournal_(props, lead, "ERROR_CHECK_GMAIL_BEFORE_RETRY", String(err).slice(0, 160));
        errors++;
        // Sending might have succeeded before an error. Never automatically retry in the same batch.
        break;
      }
    }
    return {status: "OK", sent: sent, skipped: skipped, errors: errors, attempts: attempts, today: dayCount};
  } finally {
    lock.releaseLock();
  }
}

function awfApprovedTemplate_(lead) {
  return [
    "Здравствуйте!",
    "",
    "Подготовили для «" + String(lead.company).trim() + "» современный вариант сайта.",
    "",
    "Было: " + String(lead.before).trim(),
    "",
    "Стало: " + String(lead.after).trim(),
    "",
    "Это пока демо. Все необходимые разделы, вкладки, ваши фотографии и информацию добавим бесплатно.",
    "",
    "Готовый сайт — 5 000 ₽ без доплат за нашу работу. Домен, хостинг и сторонние сервисы отдельно, если потребуются.",
    "",
    "Посмотрите, интересно ваше мнение!",
    "",
    "С уважением,",
    "Артём",
    "AI WEB FACTORY",
    "8 987 295-54-85"
  ].join("\n");
}

function awfEmail_(v) {return String(v || "").trim().toLowerCase();}
function awfBlockedCompany_(name) {
  var s = String(name || "").trim().toLowerCase();
  return s.indexOf("legoremont") >= 0 || s.indexOf("легоремонт") >= 0;
}
function awfValidLead_(lead) {
  if (!lead || typeof lead !== "object") return false;
  var email = awfEmail_(lead.email);
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email)) return false;
  if (!String(lead.company || "").trim()) return false;
  if (!/^https:\/\//.test(String(lead.before || ""))) return false;
  if (String(lead.after || "").indexOf(AWF_CONFIG.demoRoot) !== 0) return false;
  if (/[\r\n]/.test(String(lead.company))) return false;
  if (/[\r\n]/.test(String(lead.email))) return false;
  return true;
}
function awfUrlWorks_(url) {
  try {
    var response = UrlFetchApp.fetch(String(url), {muteHttpExceptions: true, followRedirects: true});
    return response.getResponseCode() === 200;
  } catch (err) {return false;}
}
function awfHash_(email) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, awfEmail_(email));
  return b.map(function(x) {return ("0" + ((x + 256) % 256).toString(16)).slice(-2);}).join("");
}
function awfJournal_(props, lead, status, details) {
  var key = "AWF_LOG_" + new Date().getTime() + "_" + Utilities.getUuid().slice(0, 8);
  props.setProperty(key, JSON.stringify({
    at: new Date().toISOString(),
    email: awfEmail_(lead.email),
    company: String(lead.company || ""),
    status: status,
    details: details
  }));
}
function awfStatus() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var keys = Object.keys(all).filter(function(k) {return k.indexOf("AWF_LOG_") === 0;}).sort();
  var journal = keys.slice(-100).map(function(k) {return JSON.parse(all[k]);});
  var tz = Session.getScriptTimeZone() || "Europe/Moscow";
  var dateStr = Utilities.formatDate(new Date(), tz, "yyyyMMdd");
  var status = {
    liveEnabled: props.getProperty("AWF_LIVE_MODE") === "ENABLED",
    limitPerDay: AWF_CONFIG.maxPerDay,
    limitPerRun: AWF_CONFIG.maxPerRun,
    minimumGapMinutes: AWF_CONFIG.minMinutesBetweenSends,
    sentToday: Number(props.getProperty("AWF_DAY_" + dateStr) || "0"),
    queued: JSON.parse(props.getProperty("AWF_LEADS_JSON") || "[]").length,
    logCount: keys.length,
    last100Events: journal,
    existingTriggers: ScriptApp.getProjectTriggers().map(function(t) {return t.getHandlerFunction();})
  };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}
