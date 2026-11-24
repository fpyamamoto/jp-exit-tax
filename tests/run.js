// Tests for jp-exit-tax.  Run from the repository root:  node tests/run.js
// The rules, dictionary, date helpers and judgement engine are extracted from the
// production index.html (from "const RULES" up to the state section) and run unchanged.
// Expected values come from the specification (Vault note "Web 出国税チェッカー の仕様書",
// section 4) and from the statutes cited there.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function check(name, cond, detail){
  if(cond){ passed++; }
  else { failed++; console.log("FAIL: " + name + (detail ? "  (" + detail + ")" : "")); }
}
function eq(name, got, want){ check(name, got === want, "got " + got + ", want " + want); }

/* ---------- extract the engine ---------- */
const start = html.indexOf("const RULES = {");
const end = html.indexOf("const TODAY=");
if(start < 0 || end < 0 || end < start){ console.log("FAIL: engine block not found"); process.exit(1); }
const E = vm.runInNewContext(html.slice(start, end) +
  "\n;({RULES, I18N, D, valuationDate, thresholdCheck, residencyCheck, buildTimeline, evaluate, surtaxNote, taxNameSuffix})", {});

const P = s => E.D.parse(s);
const iso = p => p ? E.D.iso(p) : null;
const TODAY = P("2026-11-24");
const base = o => Object.assign({isResident:true, willDepart:true, departure:null, alwaysInJapan:true,
  periods:[], hasTaxAgent:false, wantsDeferral:false, totalValue:null, gain:null}, o);
const tl = (dep, agent, deferral) => {
  const r = E.evaluate(base({departure:P(dep), hasTaxAgent:agent, wantsDeferral:deferral, totalValue:200000000}), TODAY);
  const m = {}; (r.timeline || []).forEach(i => { m[i.id] = iso(i.date); });
  return m;
};

/* ---------- spec section 4 ---------- */
// #1 / #2 threshold (1億円以上)
eq("#1 100,000,000 -> subject", E.evaluate(base({departure:P("2027-07-14"), hasTaxAgent:true, totalValue:100000000}), TODAY).verdict, "subject");
eq("#2 99,999,999 -> notSubject", E.evaluate(base({departure:P("2027-07-14"), hasTaxAgent:true, totalValue:99999999}), TODAY).verdict, "notSubject");
// #3 exactly 5 years 0 months 0 days -> not subject (5年超)
{
  const r = E.residencyCheck(P("2030-01-01"), false, [{from:P("2024-12-31"), to:P("2029-12-31")}]);
  eq("#3 span y", r.span.y, 5); eq("#3 span m", r.span.m, 0); eq("#3 span d", r.span.d, 0);
  eq("#3 exactly five years is not 'over'", r.met, false);
  const r2 = E.residencyCheck(P("2030-01-01"), false, [{from:P("2024-12-30"), to:P("2029-12-31")}]);
  eq("#3b one more day -> met", r2.met, true);
}
// #4 before 2015-07-01
eq("#4 2014-06-30 -> notSubject", E.evaluate(base({departure:P("2014-06-30"), hasTaxAgent:true, totalValue:200000000}), TODAY).verdict, "notSubject");
eq("#4b 2015-07-01 -> subject", E.evaluate(base({departure:P("2015-07-01"), hasTaxAgent:true, totalValue:200000000}), TODAY).verdict, "subject");
// #5 valuation date three months before (no agent)
eq("#5 valuation 2027-04-14", iso(E.valuationDate(P("2027-07-14"), false).date), "2027-04-14");
// #6 2026-12-31 without agent -> undecidable
eq("#6 2026-12-31 no agent -> undecidable", E.evaluate(base({departure:P("2026-12-31"), hasTaxAgent:false, totalValue:200000000}), TODAY).verdict, "undecidable");
// #7 with agent: valuation = departure, filing 2027-03-15 (Mon)
eq("#7 valuation = departure", iso(E.valuationDate(P("2026-12-31"), true).date), "2026-12-31");
eq("#7 filing with agent", tl("2026-12-31", true, false).filingWithAgent, "2027-03-15");
// #8 filing 2031-03-17 (2031-03-15 is Saturday)
eq("#8 filing with agent", tl("2030-06-01", true, false).filingWithAgent, "2031-03-17");
// #9 continuation notice: the second year after departure (Income Tax Act 137-2(6))
{
  const m = tl("2029-06-01", true, true);
  eq("#9 collateral 2030-03-15", m.collateral, "2030-03-15");
  eq("#9 first continuation notice 2031-03-17", m.continuationNotice, "2031-03-17");
}
// #10
{
  const m = tl("2025-08-01", true, true);
  eq("#10 filing 2026-03-16", m.filingWithAgent, "2026-03-16");
  eq("#10 collateral 2026-03-16", m.collateral, "2026-03-16");
  eq("#10 first continuation notice 2027-03-15", m.continuationNotice, "2027-03-15");
}
// #11 revocation by return: 5 years, or 10 years with the extension (60-2(6)(7))
{
  const m = tl("2027-05-01", true, true);
  eq("#11 revocation 5 years", m.revocationLimit, "2032-05-01");
  eq("#11 revocation 10 years (extension)", m.revocationLimitExt, "2037-05-01");
  const n = tl("2027-05-01", true, false);
  eq("#11b no deferral -> no 10-year line", n.revocationLimitExt, undefined);
  eq("#11b no deferral -> 5-year line still shown", n.revocationLimit, "2032-05-01");
}
// #12 deferral due dates
{
  const m = tl("2027-10-31", true, true);
  eq("#12 deferral due", m.deferralDue, "2033-02-28");
  eq("#12 deferral due (extended)", m.deferralDueExt, "2038-02-28");
}
// every continuation date is two years after departure, March 15 or the next Monday (2026-2040)
for(let y = 2026; y <= 2040; y++){
  const m = tl(y + "-06-01", true, true);
  const want = E.D.shiftIfWeekend({y:y+2, m:3, d:15});
  eq("continuation " + y, m.continuationNotice, iso(want));
}

/* ---------- assets (#13 / #14) ---------- */
const keys = list => list.map(a => a.key);
check("#13 partnership securities are included", keys(E.RULES.assets.included).includes("niniKumiai"));
check("#13 partnership securities are not excluded",
      !keys(E.RULES.assets.excludedCommon).includes("niniKumiai") && !keys(E.RULES.assets.excludedOptional).includes("niniKumiai"));
check("#14 stock options (qualified or not) are excluded", keys(E.RULES.assets.excludedOptional).includes("qualifiedSO"));
check("#14 ja label says both qualified and non-qualified", /税制適格・非適格のどちらも/.test(E.I18N.ja.a_qualifiedSO));
check("#14 ja note says both qualified and non-qualified", /税制適格・非適格のどちらも/.test(E.I18N.ja.s5rsNote));
check("#14 en label says qualified or not", /tax-qualified or not/.test(E.I18N.en.a_qualifiedSO));
check("#14 en note says both", /both tax-qualified and non-qualified/.test(E.I18N.en.s5rsNote));
check("#13 ja label names funds and LLPs (所基通36・37共-19)", /投資事業有限責任組合（ファンド）・LLP や海外の同様の組合を通して持つ有価証券/.test(E.I18N.ja.a_niniKumiai));
check("#13 en label names funds and LLPs", /investment limited partnership \(fund\), an LLP or a similar foreign partnership/.test(E.I18N.en.a_niniKumiai));
check("SO note: work outside Japan comes first (ja)", /海外で働いていた期間の分がある場合や、海外の親会社から/.test(E.I18N.ja.s5rsNote));
check("SO note: work outside Japan comes first (en)", /relates to work done outside Japan, or they come from an overseas parent/.test(E.I18N.en.s5rsNote));

/* ---------- estimate and the additional tax note (#15-#18) ---------- */
eq("#15 1億円 -> 15,315,000", Math.round(100000000 * E.RULES.taxRate.total), 15315000);
eq("rate unchanged from 2027", E.RULES.taxRate.total, 0.15315);
eq("#17 2026, 5億円 -> 76,575,000", Math.round(500000000 * E.RULES.taxRate.total), 76575000);
eq("#18 2027, 3.3億 -> 50,539,500", Math.round(330000000 * E.RULES.taxRate.total), 50539500);
// note only when the gain exceeds the base of Art. 41-19 for the departure year
eq("2027, gain 165,000,000 -> no note", E.surtaxNote(2027, 165000000), null);
eq("2027, gain 165,000,001 -> note", E.surtaxNote(2027, 165000001).threshold, 330000000);
eq("#16 2027, gain 5億 -> note (3.3億)", E.surtaxNote(2027, 500000000).threshold, 330000000);
eq("2026, gain 330,000,000 -> no note", E.surtaxNote(2026, 330000000), null);
eq("2026, gain 330,000,001 -> note (9.9億)", E.surtaxNote(2026, 330000001).threshold, 990000000);
eq("2025, gain 4億 -> note", E.surtaxNote(2025, 400000000).threshold, 990000000);
eq("2024, gain 10億 -> no note (rule from 2025)", E.surtaxNote(2024, 1000000000), null);
eq("no gain -> no note", E.surtaxNote(2027, null), null);
eq("zero gain -> no note", E.surtaxNote(2027, 0), null);
// tax name switches from 2027
eq("2026 -> no suffix", E.taxNameSuffix(2026), "");
eq("2027 -> 2027 suffix", E.taxNameSuffix(2027), "2027");
check("ja v_subjectSub2027 names defence tax", /防衛特別所得税/.test(E.I18N.ja.v_subjectSub2027));
check("ja estResult2027 names defence tax", /防衛特別所得税/.test(E.I18N.ja.estResult2027));
check("ja estSurtax cites Art. 41-19", /租税特別措置法41条の19/.test(E.I18N.ja.estSurtax) && /\{t\}/.test(E.I18N.ja.estSurtax));
check("en estSurtax cites Art. 41-19", /Art\. 41-19/.test(E.I18N.en.estSurtax) && /\{t\}/.test(E.I18N.en.estSurtax));
check("UI shows the surtax note element", /id="est-surtax"/.test(html));
check("UI updates the surtax note on input", /const st=document\.getElementById\('est-surtax'\);/.test(html));

/* ---------- wording ---------- */
check("tourist tax 3,000 yen (ja)", /出国1回3,000円/.test(E.I18N.ja.notthis) && !/1,000円/.test(E.I18N.ja.notthis));
check("tourist tax 3,000 yen (en)", /^This is not the International Tourist Tax added to airline tickets \(3,000 yen per departure from 1 July 2026\)\./.test(E.I18N.en.notthis));
check("crypto: 2028 (ja)", E.I18N.ja.a_cryptoNote === "2026年3月に成立し、2028年から予定されている分離課税のあとも、対象外のままです");
check("crypto: 2028 (en)", E.I18N.en.a_cryptoNote === "Not covered, and the move to separate taxation (enacted March 2026, expected from 2028) does not change that");
check("revocation: amended return (ja)", /更正の請求または修正申告/.test(E.I18N.ja.tl_revocationLimit) && /更正の請求または修正申告/.test(E.I18N.ja.tl_revocationLimitExt));
check("revocation: plain English for kosei no seikyu",
      /a request to correct the assessment \(kosei no seikyu\) or an amended return/.test(E.I18N.en.tl_revocationLimit) &&
      /a request to correct the assessment \(kosei no seikyu\) or an amended return/.test(E.I18N.en.tl_revocationLimitExt));
check("continuation: first deadline, no repeated 'every year' (ja)",
      E.I18N.ja.tl_continuationNotice === "継続適用届出書の最初の提出期限（出国の翌々年。猶予が終わるまで続きます）");
check("continuation: no 'every year' in the label (en)", !/every year/i.test(E.I18N.en.tl_continuationNotice));
check("source: NTA No.2260 listed", E.RULES.sources.primary.some(s => /2260\.htm$/.test(s.url)) && "s_ntaRate" in E.I18N.ja && "s_ntaRate" in E.I18N.en);
// readable big amounts in the surtax note
{
  const m = html.match(/function bigYen\(n\)\{[\s\S]*?\n\}/);
  check("bigYen found", !!m);
  if(m){
    const fja = vm.runInNewContext("var LANG='ja';" + m[0] + ";bigYen", {});
    const fen = vm.runInNewContext("var LANG='en';" + m[0] + ";bigYen", {});
    eq("bigYen ja 330,000,000", fja(330000000), "3億3,000万");
    eq("bigYen ja 990,000,000", fja(990000000), "9億9,000万");
    eq("bigYen en 330,000,000", fen(330000000), "330 million");
    eq("bigYen en 990,000,000", fen(990000000), "990 million");
    check("surtax note uses bigYen", /fill\('estSurtax',\{t:bigYen\(n\.threshold\)\}\)/.test(html));
  }
}
// README
{
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8").replace(/\r\n/g, "\n");
  check("README: cancellation on return survives without registration (ja)", /帰国したときの課税取消しだけは届出がなくても使えます/.test(readme));
  check("README: no 'every remedy is gone'", !/every remedy is gone/.test(readme));
  check("README: only the cancellation survives (en)", /only the cancellation on returning within five years survives without it/.test(readme));
  check("README: asset counts", readme.includes("数えるもの" + E.RULES.assets.included.length + "件／数えないもの" + E.RULES.assets.excludedCommon.length + "件"));
  const nKeys = Object.keys(E.I18N.ja).length;
  check("README: dictionary key count (en)", readme.includes(nKeys + "-key bilingual dictionary"));
  check("README: dictionary key count (ja)", readme.includes("日英で" + nKeys + "キー"));
  const nums = (readme.match(/日英で(\d+)キー|(\d+)-key bilingual/g) || []);
  check("README: no other key counts", nums.length === 2, nums.join(","));
  // plan C: only verifiable test counts in public text
  for(const bad of ["461", "計461件", "80件", "121件", "203件", "57件", "522件", "260件", "60,000", "260 tests", "7回間違"]){
    check("README: no unverifiable count '" + bad + "'", !readme.includes(bad));
  }
  check("README: main door (en)", /\*\*Registration is the main door, and it closes at the moment of departure\.\*\*/.test(readme));
  check("README: 'どちらも' and the exception in brackets (ja)",
        /どちらも「国外転出の時までに納税管理人の届出をする」ことが前提です（帰国したときの課税取消しだけは届出がなくても使えます）。飛行機に乗ってから気づいても、もう間に合いません。/.test(readme));
  check("continuation (en): 'after the year you leave'", /the second year after the year you leave/.test(E.I18N.en.tl_continuationNotice));
}

eq("law as of", E.RULES.meta.lawAsOf, "2026-11-24");

/* ---------- dictionaries ---------- */
{
  const ja = Object.keys(E.I18N.ja), en = Object.keys(E.I18N.en);
  eq("I18N key count ja = en", ja.length, en.length);
  const missEn = ja.filter(k => !(k in E.I18N.en)), missJa = en.filter(k => !(k in E.I18N.ja));
  check("every ja key is in en", missEn.length === 0, missEn.join(","));
  check("every en key is in ja", missJa.length === 0, missJa.join(","));
  const jpRe = /[぀-ヿ㐀-鿿！-）＋-｠]/;
  const jpInEn = en.filter(k => typeof E.I18N.en[k] === "string" && jpRe.test(E.I18N.en[k]));
  check("no Japanese left in the English dictionary", jpInEn.length === 0, jpInEn.join(","));
  // every timeline id has a label
  for(const it of E.RULES.timeline.transfer){
    check("label tl_" + it.id, ("tl_" + it.id) in E.I18N.ja && ("tl_" + it.id) in E.I18N.en);
  }
  for(const a of [...E.RULES.assets.included, ...E.RULES.assets.excludedCommon, ...E.RULES.assets.excludedOptional]){
    check("asset label a_" + a.key, ("a_" + a.key) in E.I18N.ja && ("a_" + a.key) in E.I18N.en);
    if(a.note) check("asset note a_" + a.note, ("a_" + a.note) in E.I18N.ja && ("a_" + a.note) in E.I18N.en);
  }
}

/* ---------- keep this last: the README states the number of checks in this file (ja and en) ---------- */
{
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8").replace(/\r\n/g, "\n");
  const total = passed + failed + 1;   // including this check
  const ja = (readme.match(/`tests\\run\.js` に試験が(\d+)件あります/) || [])[1];
  const en = (readme.match(/`tests\/run\.js` holds (\d+) checks/) || [])[1];
  check("README states the real number of checks (ja " + ja + ", en " + en + ", actual " + total + ")",
        Number(ja) === total && Number(en) === total);
}

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
