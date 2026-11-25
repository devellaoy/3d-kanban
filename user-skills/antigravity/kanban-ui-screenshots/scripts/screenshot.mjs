#!/usr/bin/env node
// Ottaa screenshotin (oletuksena koko sivu) annetusta URL:sta ja tallentaa sen
// käyttöjärjestelmän temp-kansioon. Tukee myös SPA-sivuja (odottaa renderöinnin).
//
// TULOSTUSSOPIMUS:
//   stdout = pelkkiä kuvien absoluuttisia polkuja, yksi per rivi (viimeinen rivi on
//            viimeisin kuva — yhden kuvan ajossa siis "se" kuva).
//   stderr = kaikki muu: mittaustulokset, eteneminen, varoitukset.
// Näin polun voi aina poimia stdoutista koneellisesti, myös monivaiheisessa ajossa.
//
// Käyttö (yksi kuva):
//   node screenshot.mjs <url> [--name nimi] [--wait-selector sel]
//                              [--width 1280] [--height 900] [--device "iPhone 14"]
//                              [--mobile] [--dpr 2] [--viewport-only]
//                              [--timeout 30000] [--delay 800]
//                              [--channel chrome|msedge]
//                              [--click sel ...] [--eval "js"] [--eval-file polku]
//                              [--post-delay ms]
//                              [--scroll-to sel]
//                              [--clip-selector sel] [--clip-padding 20]
//                              [--measure sel ...]
//                              [--cookie nimi=arvo ...] [--local-storage avain=arvo ...]
//                              [--session-storage avain=arvo ...] [--storage-file polku]
//                              [--state polku.json]
//
// Käyttö (monivaiheinen polku, yksi selainistunto, useita kuvia):
//   node screenshot.mjs --flow polku.json
//
// -- Näyttökoko ja mobiili --------------------------------------------------------
//   --device "iPhone 14"  Playwrightin laitepreset (viewport + dpr + isMobile +
//                         hasTouch + userAgent). Listaa nimet: --list-devices.
//   --width / --height    Näkymän koko pikseleinä (oletus 1280x900).
//   --mobile              isMobile + hasTouch päälle (mobiiliselaimen layout).
//   --dpr <n>             deviceScaleFactor, esim. 2 = retina-tarkkuus.
//   --viewport-only       Kuvaa vain näkymän, ei koko sivua (mobiilin "above the fold").
//   Yksittäiset liput ohittavat --devicen arvot, esim:
//     --device "iPhone 14" --dpr 1
//
// -- Istunnon säilyttäminen ajojen välillä ----------------------------------------
//   --state <polku.json>  Lataa istunnon tiedostosta ENNEN ajoa ja tallentaa sen
//                         takaisin ajon JÄLKEEN (evästeet + localStorage +
//                         sessionStorage). Näin peräkkäiset ajot jatkavat samaa
//                         istuntoa: esim. ajo 1 lisää tuotteen koriin, ajo 2 kuvaa
//                         ostoskorin ja kori on yhä täynnä. Tiedostoa ei tarvitse
//                         luoda etukäteen.
//   HUOM: jos koko polku on tehtävissä kerralla, --flow on luotettavampi (sama
//   selain ja sama välimuisti koko ajan) — --state on ajojen VÄLINEN silta.
//
// -- Kirjautumista vaativat sivut -------------------------------------------------
//   --cookie nimi=arvo            Asettaa evästeen kohde-URL:lle (toistettava).
//   --local-storage avain=arvo    Asettaa localStorage-arvon ennen sivun skriptejä (toistettava).
//   --session-storage avain=arvo  Kuten yllä mutta sessionStorage (toistettava).
//   --storage-file <polku>        JSON-tiedosto monimutkaisille arvoille, muoto:
//                                 { "cookies": [{ "name": "...", "value": "..." }],
//                                   "localStorage": { "avain": "arvo" },
//                                   "sessionStorage": { "avain": "arvo" } }
//                                 (arvo voi olla myös objekti — serialisoidaan JSONiksi)
//
// -- Toiminnot ennen kuvaa --------------------------------------------------------
//   --click <selector>   Klikkaa elementtiä (toistettava: usea --click peräkkäin).
//   --eval "<js>"        Suorittaa JS:n sivun kontekstissa (await sallittu).
//   --eval-file <polku>  Kuten --eval mutta JS luetaan tiedostosta (monirivinen).
//   --post-delay <ms>    Odota toimintojen jälkeen ennen kuvaa (animaatiot/modaali).
//   --scroll-to <sel>    Vierittää elementin näkyviin ennen kuvaa.
//
// -- Rajattu kuva ja mittaukset ---------------------------------------------------
//   --clip-selector <sel>  Kuvaa vain tämän elementin (lähikuva napista/kortista).
//   --clip-padding <px>    Marginaali rajauksen ympärille (oletus 16).
//   --measure <sel>        Tulostaa elementin mitat ja tekstin ylivuodon JSONina
//                          stderriin (toistettava). Kertoo mm. leikkautuuko teksti:
//                          kenttä "clippedHorizontally" ja "textOverflowPx".
//                          Tämä on usein vakuuttavampi todiste kuin pelkkä kuva.
//
// -- Flow-tiedosto (monivaiheinen polku) ------------------------------------------
//   --flow <polku.json>   Ajaa askelsarjan yhdessä selainistunnossa. Muoto:
//     {
//       "name": "kori-mobiili",
//       "baseUrl": "http://localhost:9036",          // valinnainen, gotojen etuliite
//       "viewport": { "device": "iPhone 14" },        // tai { width, height, mobile, dpr }
//       "state": "/tmp/istunto.json",                 // valinnainen, kuten --state
//       "steps": [
//         { "goto": "/demo/fi/course/3248", "waitSelector": "main" },
//         { "click": "button.add-to-cart", "wait": 2000 },
//         { "goto": "/demo/fi/cart" },
//         { "measure": "button.is-primary" },
//         { "shot": "01-kori" },
//         { "shot": "02-nappi-lahikuva", "clipSelector": "button.is-primary" },
//         { "eval": "document.querySelector('button').style.whiteSpace='nowrap'" },
//         { "shot": "03-ennen-korjausta", "clipSelector": "button.is-primary" },
//         { "viewport": { "width": 1440, "height": 900 }, "shot": "04-tyopoyta" }
//       ]
//     }
//   Askeleen avaimet suoritetaan tässä järjestyksessä:
//     goto → viewport → waitSelector → wait → click → eval/evalFile → postDelay →
//     scrollTo → measure → shot
//   Yksi askel voi sisältää useita avaimia. Jos tarvitset toisen järjestyksen,
//   jaa se useaksi askeleeksi. "click" ja "measure" voivat olla myös taulukoita.
//   Näkymän vaihto kesken flowin säilyttää istunnon: jos vaihto vaatii uuden
//   kontekstin (mobiili↔työpöytä, dpr), evästeet ja storaget siirretään mukana.
//
// Käyttää järjestelmän selainta (oletus Chrome, sitten Edge) playwright-coren kautta,
// joten erillistä Chromium-latausta ei tarvita. Riippuvuus playwright-core resolvoituu
// tämän tiedoston sijainnista, joten skripti toimii vaikka se ajetaan kohderepon
// worktreessä jossa sitä ei ole asennettu.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { validateTestSteps, runActions, runAssertions } from './ui-test.mjs'

/** Kaikki ei-polkutuloste menee stderriin, jotta stdout pysyy pelkkinä kuvapolkuina. */
function note(msg) {
  process.stderr.write(msg + '\n')
}

/**
 * Käyttäjän/kutsujan virhe (väärä lippu, puuttuva elementti, virheellinen flow).
 * Näistä tulostetaan pelkkä selkeä viesti ilman stack tracea, jotta syy näkyy heti.
 */
class UserError extends Error {}

/** Kuvan polku stdoutiin — tämä on skriptin ainoa stdout-tuloste. */
function emitPath(p) {
  process.stdout.write(p + '\n')
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      let key = a.slice(2)
      let val
      const eq = key.indexOf('=')
      if (eq >= 0) {
        val = key.slice(eq + 1)
        key = key.slice(0, eq)
      } else {
        const next = argv[i + 1]
        // Seuraava token on arvo, ellei se itse näytä lipulta (--xxx).
        if (next !== undefined && !/^--/.test(next)) {
          val = next
          i++
        } else {
          val = true
        }
      }
      // Toistettu lippu (esim. usea --click) kerätään taulukoksi.
      if (key in args) {
        if (Array.isArray(args[key])) args[key].push(val)
        else args[key] = [args[key], val]
      } else {
        args[key] = val
      }
    } else {
      args._.push(a)
    }
  }
  return args
}

function posNum(v, def) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : def
}

/** Lippu ilman arvoa (--mobile) tai eksplisiittinen --mobile=false. */
function boolFlag(v, def = false) {
  if (v === undefined) return def
  if (v === true) return true
  if (typeof v === 'string') return !/^(false|0|no|off)$/i.test(v)
  return def
}

function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shot'
}

/** Palauttaa lipun arvot aina taulukkona (lippu voi toistua tai puuttua).
 *  Kaataa selkeään virheeseen jos arvo puuttui (parseArgs jätti true:n),
 *  esim. "--cookie --local-storage x=y" — muuten lippu ohitettaisiin hiljaa. */
function asList(v, flag) {
  if (v == null) return []
  const arr = Array.isArray(v) ? v : [v]
  for (const x of arr) {
    if (typeof x !== 'string') {
      throw new UserError(`${flag} vaatii arvon muodossa avain=arvo (käytä lainausmerkkejä tai ${flag}=avain=arvo)`)
    }
  }
  return arr
}

/** Kuten asList, mutta pelkille merkkijonoarvoille (esim. --click, --measure). */
function asStringList(v) {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string')
}

/** Poimii tiedostosta tulleesta evästeestä vain Playwrightin tuntemat kentät
 *  (DevTools-exportissa on ylimääräisiä kuten hostOnly, jotka voivat kaataa addCookies). */
function pickCookieFields(c) {
  const out = { name: c.name, value: String(c.value) }
  for (const k of ['url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']) {
    if (c[k] !== undefined) out[k] = c[k]
  }
  return out
}

/** Jakaa "avain=arvo"-merkkijonon ENSIMMÄISESTÄ =-merkistä (arvo saa sisältää =). */
function splitKeyValue(s, flag) {
  const i = s.indexOf('=')
  if (i <= 0) {
    throw new UserError(`Virheellinen ${flag}-arvo "${s}" — odotettu muoto avain=arvo`)
  }
  return [s.slice(0, i), s.slice(i + 1)]
}

/** Serialisoi storage-arvon merkkijonoksi (objektit JSONiksi). */
function storageValue(v) {
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/**
 * Kokoaa istuntotiedot CLI-lipuista ja mahdollisesta --storage-file-JSONista.
 * Palauttaa { cookies: [{name,value}], localStorage: {k:v}, sessionStorage: {k:v} }.
 */
async function collectSessionState(args) {
  const state = { cookies: [], localStorage: {}, sessionStorage: {} }

  if (typeof args['storage-file'] === 'string') {
    let raw
    try {
      raw = JSON.parse(await readFile(args['storage-file'], 'utf-8'))
    } catch (err) {
      throw new UserError(
        `Storage-tiedostoa ei voitu lukea/jäsentää: ${args['storage-file']}\n${err?.message ?? err}`,
      )
    }
    for (const c of Array.isArray(raw?.cookies) ? raw.cookies : []) {
      if (c && typeof c.name === 'string' && c.name.length > 0 && c.value != null) {
        state.cookies.push(pickCookieFields(c))
      }
    }
    for (const [k, v] of Object.entries(raw?.localStorage ?? {})) state.localStorage[k] = storageValue(v)
    for (const [k, v] of Object.entries(raw?.sessionStorage ?? {})) state.sessionStorage[k] = storageValue(v)
  }

  for (const c of asList(args.cookie, '--cookie')) {
    const [name, value] = splitKeyValue(c, '--cookie')
    state.cookies.push({ name, value })
  }
  for (const s of asList(args['local-storage'], '--local-storage')) {
    const [k, v] = splitKeyValue(s, '--local-storage')
    state.localStorage[k] = v
  }
  for (const s of asList(args['session-storage'], '--session-storage')) {
    const [k, v] = splitKeyValue(s, '--session-storage')
    state.sessionStorage[k] = v
  }
  return state
}

function normalizeUrl(u) {
  // Lisää http:// jos protokolla puuttuu (esim. "localhost:3000").
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u
  return 'http://' + u
}

// Ohitetaan kaikki SSL-/sertifikaattivirheet myös selainprosessin tasolla, jotta
// epäturvallinenkin https (self-signed, väärä CN, vanhentunut cert) toimii.
const INSECURE_TLS_ARGS = [
  '--ignore-certificate-errors',
  '--ignore-certificate-errors-spki-list',
  '--allow-insecure-localhost',
]

async function launchBrowser(chromium, channelPref) {
  // Chrome ensin molemmilla käyttöjärjestelmillä, Edge vasta varalla.
  const candidates = channelPref ? [channelPref] : ['chrome', 'msedge', 'chromium']
  let lastErr
  for (const channel of candidates) {
    try {
      return await chromium.launch({ headless: true, channel, args: INSECURE_TLS_ARGS })
    } catch (e) {
      lastErr = e
    }
  }
  // Viimeinen oljenkorsi: playwrightin oma chromium, jos sellainen on asennettu.
  try {
    return await chromium.launch({ headless: true, args: INSECURE_TLS_ARGS })
  } catch (e) {
    throw new UserError(
      `Selaimen käynnistys epäonnistui. Kokeiltu kanavat: ${candidates.join(', ')}. ` +
        `Varmista että Chrome tai Edge on asennettu, tai anna --channel. Virhe: ${
          lastErr?.message ?? e?.message ?? e
        }`,
    )
  }
}

// ---------------------------------------------------------------------------------
// Näkymä (viewport) — laitepresetit ja mobiiliemulointi
// ---------------------------------------------------------------------------------

const DEFAULT_VIEWPORT = { width: 1280, height: 900 }

/**
 * Rakentaa Playwrightin kontekstiasetukset näkymämäärittelystä.
 * spec: { device?, width?, height?, mobile?, dpr? } — yksittäiset kentät ohittavat
 * devicen arvot. Palauttaa objektin joka kelpaa suoraan newContextille.
 */
function resolveViewport(spec, deviceRegistry) {
  const out = {
    viewport: { ...DEFAULT_VIEWPORT },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }

  if (spec?.device) {
    const preset = deviceRegistry?.[spec.device]
    if (!preset) {
      const sample = Object.keys(deviceRegistry ?? {}).slice(0, 8).join(', ')
      throw new UserError(
        `Tuntematon --device "${spec.device}". Listaa kaikki: --list-devices. Esimerkkejä: ${sample}`,
      )
    }
    // defaultBrowserType kuuluu presetiin muttei kontekstin asetuksiin.
    const { defaultBrowserType, screen, ...usable } = preset
    Object.assign(out, usable)
    out.viewport = { ...preset.viewport }
  }

  if (spec?.width != null) out.viewport.width = posNum(spec.width, out.viewport.width)
  if (spec?.height != null) out.viewport.height = posNum(spec.height, out.viewport.height)
  if (spec?.dpr != null) out.deviceScaleFactor = posNum(spec.dpr, out.deviceScaleFactor)
  if (spec?.mobile != null) {
    out.isMobile = !!spec.mobile
    out.hasTouch = !!spec.mobile
  }
  return out
}

/** Vaatiiko näkymän vaihto uuden kontekstin? Pelkkä koko onnistuu ilman. */
function needsNewContext(a, b) {
  return (
    a.isMobile !== b.isMobile ||
    a.hasTouch !== b.hasTouch ||
    a.deviceScaleFactor !== b.deviceScaleFactor ||
    (a.userAgent ?? null) !== (b.userAgent ?? null)
  )
}

// ---------------------------------------------------------------------------------
// Istunnon talteenotto ja palautus (--state / flow "state")
// ---------------------------------------------------------------------------------

/** Lukee istuntotiedoston. Puuttuva tiedosto ei ole virhe — istunto alkaa tyhjänä. */
async function loadStateFile(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    return {
      cookies: Array.isArray(raw?.cookies) ? raw.cookies : [],
      origins: Array.isArray(raw?.origins) ? raw.origins : [],
      sessionStorage: raw?.sessionStorage && typeof raw.sessionStorage === 'object' ? raw.sessionStorage : {},
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      note(`Varoitus: istuntotiedostoa ei voitu lukea (${path}): ${err?.message ?? err} — aloitetaan tyhjästä.`)
    }
    return null
  }
}

/** Lukee sivun sessionStoragen (Playwrightin storageState ei sisällä sitä). */
async function readSessionStorage(page) {
  if (!page) return {}
  try {
    return await page.evaluate(() => {
      const out = {}
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)
        if (k != null) out[k] = sessionStorage.getItem(k)
      }
      return out
    })
  } catch {
    return {}
  }
}

/** Tallentaa evästeet + localStorage (Playwrightin storageState) + sessionStoragen. */
async function saveStateFile(context, page, path) {
  try {
    const base = await context.storageState()
    const sessionStorage = await readSessionStorage(page)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ...base, sessionStorage }, null, 2), 'utf-8')
    note(`Istunto tallennettu: ${path}`)
  } catch (err) {
    note(`Varoitus: istunnon tallennus epäonnistui (${path}): ${err?.message ?? err}`)
  }
}

// ---------------------------------------------------------------------------------
// Kontekstin luonti
// ---------------------------------------------------------------------------------

/**
 * Luo selainkontekstin näkymäasetuksilla ja istuntotiedoilla.
 * @param persisted Playwrightin storageState-muotoinen objekti tai null.
 * @param session   CLI-lipuista kerätyt cookie/localStorage/sessionStorage-arvot.
 */
async function createContext(browser, vp, session, persisted, targetUrl) {
  const context = await browser.newContext({
    viewport: vp.viewport,
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    ...(vp.userAgent ? { userAgent: vp.userAgent } : {}),
    // Ohita kaikki SSL-/sertifikaattivirheet (esim. self-signed localhost-https).
    ignoreHTTPSErrors: true,
    ...(persisted ? { storageState: { cookies: persisted.cookies ?? [], origins: persisted.origins ?? [] } } : {}),
  })

  // Evästeet: domain-pohjaisina, jotta ne kelpaavat vaikka navigointi putoaisi
  // https:stä http:hen. Tiedostosta tulleet voivat tuoda omat domain/path-kentät.
  if (session.cookies.length) {
    const { hostname } = new URL(targetUrl)
    await context.addCookies(
      session.cookies.map((c) => (c.domain || c.url ? c : { ...c, domain: hostname, path: c.path ?? '/' })),
    )
  }

  // local/sessionStorage: init-skripti ajetaan ennen sivun omia skriptejä, joten
  // arvot ovat olemassa heti kun sovellus käynnistyy (esim. auth-token).
  // Mukaan myös istuntotiedostosta palautettu sessionStorage.
  const sessionStorage = { ...(persisted?.sessionStorage ?? {}), ...session.sessionStorage }
  if (Object.keys(session.localStorage).length || Object.keys(sessionStorage).length) {
    await context.addInitScript(
      (data) => {
        for (const [k, v] of Object.entries(data.localStorage)) window.localStorage.setItem(k, v)
        for (const [k, v] of Object.entries(data.sessionStorage)) window.sessionStorage.setItem(k, v)
      },
      { localStorage: session.localStorage, sessionStorage },
    )
  }
  return context
}

// ---------------------------------------------------------------------------------
// Sivun avaus, lazy-load, mittaus, kuvaus
// ---------------------------------------------------------------------------------

// Vierittää sivun pohjalle ja takaisin, jotta lazy-load-kuvat (loading="lazy" /
// IntersectionObserver) ehtivät latautua ennen full-page-kuvaa.
async function triggerLazyLoad(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0
      let ticks = 0
      const step = 600
      const timer = setInterval(() => {
        window.scrollBy(0, step)
        total += step
        ticks++
        // Lopeta kun pohja saavutettu tai turvaraja (n. 30s) ylittyy.
        if (total >= document.body.scrollHeight || ticks > 300) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })
  })
  await page.evaluate(() => window.scrollTo(0, 0))
}

// Avaa sivun ja navigoi kestävästi. Käyttää TUORETTA sivua joka yritykselle, jolloin
// epäonnistuneen navigoinnin jättämä virhesivu (chrome-error://) ei voi keskeyttää
// seuraavaa yritystä. Ohittaa SSL-/protokollavirheet kokeilemalla http:tä.
async function openPage(context, initialUrl, timeout) {
  let url = initialUrl
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    const page = await context.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
      return { page, url }
    } catch (err) {
      lastErr = err
      const msg = String(err?.message ?? err)
      await page.close().catch(() => {})
      if (/^https:\/\//i.test(url) && /SSL|ERR_CONNECTION|protocol/i.test(msg)) {
        // Dev-serveri on usein pelkkä http — vaihda protokolla ja yritä uudella sivulla.
        url = url.replace(/^https:\/\//i, 'http://')
        continue
      }
      if (/interrupted by another navigation|chrome-error|ERR_ABORTED/i.test(msg)) {
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/** Navigoi jo avatulla sivulla (flow'n goto-askeleet). */
async function navigate(page, url, timeout) {
  let target = url
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout })
      return target
    } catch (err) {
      const msg = String(err?.message ?? err)
      if (/^https:\/\//i.test(target) && /SSL|ERR_CONNECTION|protocol/i.test(msg)) {
        target = target.replace(/^https:\/\//i, 'http://')
        continue
      }
      if (/interrupted by another navigation|chrome-error|ERR_ABORTED/i.test(msg)) continue
      throw err
    }
  }
  throw new Error(`Navigointi epäonnistui: ${url}`)
}

/** Antaa verkon rauhoittua, mutta ei kaadu jos networkidle ei koskaan laukea. */
async function settle(page, timeout, delay) {
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 8000) })
  } catch {
    // SPA:lla voi olla pysyviä yhteyksiä — jatketaan silti.
  }
  if (delay > 0) await page.waitForTimeout(delay)
}

/**
 * Mittaa elementin: koko, lasketut tyylit, rivimäärä ja tekstin vaakaylivuoto.
 * Tämä vastaa kysymykseen "leikkautuuko teksti / rivittyykö se" numeroilla, jolloin
 * lopputulosta ei tarvitse päätellä pelkästä kuvasta.
 */
async function measureElement(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { selector: sel, error: 'elementtiä ei löytynyt' }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const px = (v) => parseFloat(v) || 0
    const contentWidth =
      r.width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth)
    const contentHeight =
      r.height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth)
    // Tekstin todellinen leveys mitataan Rangella, koska pelkkä scrollWidth ei
    // paljasta ylivuotoa inline-flex-elementeissä (esim. Bulman .button).
    const range = document.createRange()
    range.selectNodeContents(el)
    const textRect = range.getBoundingClientRect()
    const lineHeight = px(cs.lineHeight) || px(cs.fontSize) * 1.2
    const overflow = Math.round(textRect.width - contentWidth)
    return {
      selector: sel,
      text: (el.textContent || '').trim().slice(0, 120),
      rect: { width: Math.round(r.width), height: Math.round(r.height) },
      styles: {
        display: cs.display,
        whiteSpace: cs.whiteSpace,
        height: cs.height,
        padding: cs.padding,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        overflow: cs.overflow,
      },
      lines: lineHeight > 0 ? Math.max(1, Math.round(contentHeight / lineHeight)) : null,
      contentWidth: Math.round(contentWidth),
      textWidth: Math.round(textRect.width),
      textOverflowPx: overflow,
      clippedHorizontally: overflow > 1,
      pageHorizontalOverflowPx:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // Sivun TODELLINEN layout-leveys. Jos tämä ei vastaa pyydettyä näkymää mobiilissa,
      // sivulta puuttuu <meta name="viewport"> ja selain käyttää 980px:n legacy-leveyttä —
      // silloin mobiilibugi ei toistu vaikka --device olisi oikein.
      layoutViewportWidth: document.documentElement.clientWidth,
      hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
    }
  }, selector)
}

/** Elementin sijainti dokumentin koordinaateissa (clip odottaa niitä full-page-kuvassa). */
async function elementBox(page, selector, padding) {
  const box = await page.evaluate(
    ({ sel, pad }) => {
      const el = document.querySelector(sel)
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return {
        x: Math.max(0, r.left + window.scrollX - pad),
        y: Math.max(0, r.top + window.scrollY - pad),
        width: r.width + pad * 2,
        height: r.height + pad * 2,
      }
    },
    { sel: selector, pad: padding },
  )
  if (!box) throw new UserError(`Elementtiä ei löytynyt rajaukseen (clipSelector): ${selector}`)
  return box
}

/**
 * Ottaa kuvan ja palauttaa polun.
 * clipSelector → lähikuva elementistä, viewportOnly → vain näkymä, muuten koko sivu.
 */
async function capture(page, outPath, { clipSelector, clipPadding, viewportOnly }) {
  if (clipSelector) {
    const clip = await elementBox(page, clipSelector, clipPadding)
    await page.screenshot({ path: outPath, fullPage: true, clip })
  } else if (viewportOnly) {
    await page.screenshot({ path: outPath, fullPage: false })
  } else {
    await triggerLazyLoad(page)
    await page.screenshot({ path: outPath, fullPage: true })
  }
  return outPath
}

// ---------------------------------------------------------------------------------
// Flow-ajo
// ---------------------------------------------------------------------------------

/** Yhdistää baseUrlin ja suhteellisen polun. */
function joinUrl(baseUrl, target) {
  if (!baseUrl) return normalizeUrl(target)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target
  return new URL(target, normalizeUrl(baseUrl)).toString()
}

async function runFlow(flow, ctx) {
  const { browser, session, deviceRegistry, outDir, timeout, delay } = ctx
  const flowName = slug(flow.name || 'flow')
  const statePath = flow.state ? resolve(flow.state) : ctx.statePath

  let vp = resolveViewport(flow.viewport ?? {}, deviceRegistry)
  let persisted = statePath ? await loadStateFile(statePath) : null

  const steps = Array.isArray(flow.steps) ? flow.steps : []
  if (!steps.length) throw new UserError('Flow-tiedostossa ei ole yhtään askelta ("steps").')
  const stepKeys = new Set(['goto', 'viewport', 'waitSelector', 'wait', 'click', 'eval', 'evalFile', 'postDelay', 'scrollTo', 'measure', 'shot', 'clipSelector', 'clipPadding', 'viewportOnly', 'delay', 'actions', 'assertions'])
  for (const step of steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => !stepKeys.has(key))) {
      throw new UserError('Invalid flow step or unknown step key')
    }
  }
  try { validateTestSteps(steps) } catch (error) { throw new UserError(error.message) }
  for (const key of ['trace', 'includeValues', 'failOnPageError']) {
    if (flow[key] !== undefined && typeof flow[key] !== 'boolean') throw new UserError(`${key} must be boolean`)
  }
  const faults = flow.networkFailures ?? []
  if (!Array.isArray(faults) || faults.some(f => !f || typeof f.url !== 'string' || !f.url
    || !Number.isInteger(f.times) || f.times < 1 || Object.keys(f).some(k => !['url', 'times'].includes(k)))) {
    throw new UserError('networkFailures must contain {url: glob, times: positive integer}')
  }
  const remainingFaults = faults.map(fault => ({ ...fault, remaining: fault.times }))

  // Ensimmäinen goto tarvitaan kontekstin evästedomainia varten.
  const firstGoto = steps.find((s) => typeof s.goto === 'string')
  if (!firstGoto) throw new UserError('Flow-tiedoston pitää sisältää vähintään yksi "goto"-askel.')
  const firstUrl = joinUrl(flow.baseUrl, firstGoto.goto)

  let context = await createContext(browser, vp, session, persisted, firstUrl)
  let page = await context.newPage()
  let shotIndex = 0
  const runId = `${flowName}-${Date.now()}-${process.pid}`
  const reportPath = join(outDir, `${runId}-report.json`)
  const report = { status: 'running', steps: [], diagnostics: [], screenshots: [], traces: [], simulatedNetworkFailures: faults.length, droppedDiagnostics: 0, pageErrorCount: 0 }
  let currentStep = null
  let traceIndex = 0
  let traceActive = false
  const record = data => {
    if (data.type === 'pageerror') report.pageErrorCount++
    if (report.diagnostics.length < 200) report.diagnostics.push({ step: currentStep?.index ?? null, ...data })
    else report.droppedDiagnostics++
  }
  const safeUrl = url => { try { return new URL(url).origin } catch { return '[redacted]' } }
  const attachPage = p => {
    p.on('console', msg => {
      if (['error', 'warning'].includes(msg.type())) record({ type: 'console', level: msg.type(), ...(flow.includeValues ? { message: msg.text().slice(0, 1000) } : {}) })
    })
    p.on('pageerror', err => record({ type: 'pageerror', ...(flow.includeValues ? { message: err.message.slice(0, 1000) } : {}) }))
  }
  const setupContext = async () => {
    attachPage(page)
    context.on('page', attachPage)
    context.on('requestfailed', request => record({ type: 'requestfailed', origin: safeUrl(request.url()), method: request.method(), resourceType: request.resourceType() }))
    context.on('response', response => {
      if (response.status() >= 400) record({ type: 'http', origin: safeUrl(response.url()), status: response.status(), method: response.request().method() })
    })
    for (const fault of remainingFaults) {
      await context.route(fault.url, async route => {
        if (fault.remaining <= 0) return route.fallback()
        fault.remaining--
        record({ type: 'simulated-network-failure', origin: safeUrl(route.request().url()) })
        await route.abort('failed')
      })
    }
    if (flow.trace) {
      note('TRACE: may contain DOM, network data and secrets; use test accounts only.')
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
      traceActive = true
    }
  }
  const stopTrace = async () => {
    if (!traceActive) return
    traceActive = false
    const path = join(outDir, `${runId}-trace-${++traceIndex}.zip`)
    await context.tracing.stop({ path })
    report.traces.push(path)
  }

  const recreateContext = async (nextVp) => {
    // Näkymän vaihto joka vaatii uuden kontekstin: siirretään istunto mukana,
    // jottei esim. ostoskori tyhjene mobiili→työpöytä-vaihdossa.
    const carried = {
      ...(await context.storageState()),
      sessionStorage: await readSessionStorage(page),
    }
    const currentUrl = page.url()
    await stopTrace()
    await context.close()
    context = await createContext(browser, nextVp, session, carried, currentUrl || firstUrl)
    page = await context.newPage()
    await setupContext()
    if (currentUrl && !/^about:/.test(currentUrl)) {
      await navigate(page, currentUrl, timeout)
      await settle(page, timeout, delay)
    }
  }

  try {
    await setupContext()
    for (const [i, step] of steps.entries()) {
      const label = `askel ${i + 1}/${steps.length}`
      currentStep = { index: i + 1, status: 'running', actions: [], assertions: [] }
      report.steps.push(currentStep)

      if (typeof step.goto === 'string') {
        const url = joinUrl(flow.baseUrl, step.goto)
        note(`${label}: goto ${url}`)
        await navigate(page, url, timeout)
        await settle(page, timeout, step.delay != null ? posNum(step.delay, delay) : delay)
      }

      if (step.viewport) {
        const nextVp = resolveViewport({ ...step.viewport }, deviceRegistry)
        if (needsNewContext(vp, nextVp)) {
          note(`${label}: näkymä vaihtuu (uusi konteksti, istunto siirretään)`)
          await recreateContext(nextVp)
        } else {
          await page.setViewportSize(nextVp.viewport)
        }
        vp = nextVp
        note(`${label}: viewport ${vp.viewport.width}x${vp.viewport.height} mobile=${vp.isMobile} dpr=${vp.deviceScaleFactor}`)
      }

      if (typeof step.waitSelector === 'string') {
        await page.waitForSelector(step.waitSelector, { timeout })
      }

      if (step.wait != null) {
        await page.waitForTimeout(posNum(step.wait, 0))
      }

      for (const sel of asStringList(step.click)) {
        note(`${label}: click ${sel}`)
        await page.click(sel, { timeout })
      }

      currentStep.actions = await runActions(page, step.actions ?? [], { timeout, flowDir: ctx.flowDir })

      let js = typeof step.eval === 'string' ? step.eval : null
      if (typeof step.evalFile === 'string') js = await readFile(step.evalFile, 'utf-8')
      if (js) {
        const value = await page.evaluate(`(async () => { ${js}\n})()`)
        if (value !== undefined) note(`${label}: eval -> ${JSON.stringify(value)}`)
      }

      if (step.postDelay != null) await page.waitForTimeout(posNum(step.postDelay, 0))

      if (typeof step.scrollTo === 'string') {
        await page.evaluate((sel) => {
          document.querySelector(sel)?.scrollIntoView({ block: 'center' })
        }, step.scrollTo)
        await page.waitForTimeout(300)
      }

      for (const sel of asStringList(step.measure)) {
        const m = await measureElement(page, sel)
        note(`MEASURE ${JSON.stringify(m)}`)
      }

      currentStep.assertions = await runAssertions(page, step.assertions ?? [], { timeout, includeValues: flow.includeValues === true })

      if (step.shot) {
        shotIndex++
        const shotName = typeof step.shot === 'string' ? slug(step.shot) : `shot-${shotIndex}`
        const outPath = join(outDir, `${flowName}-${shotName}-${Date.now()}.png`)
        await capture(page, outPath, {
          clipSelector: typeof step.clipSelector === 'string' ? step.clipSelector : null,
          clipPadding: step.clipPadding != null ? Number(step.clipPadding) : 16,
          viewportOnly: !!step.viewportOnly,
        })
        emitPath(outPath)
        report.screenshots.push(outPath)
      }
      currentStep.status = 'passed'
    }

    if (flow.failOnPageError && report.pageErrorCount > 0) throw new Error('Page JavaScript error')
    report.status = report.steps.some(s => s.assertions.length > 0) ? 'passed' : 'capture-only'

    if (statePath) await saveStateFile(context, page, statePath)
  } catch (error) {
    report.status = 'failed'
    if (currentStep) {
      currentStep.status = 'failed'
      currentStep.failure = error.failure ?? { type: 'browser-operation', message: 'Browser operation failed; inspect screenshot and diagnostics.' }
      if (error.records) currentStep.partialResults = error.records
    }
    const path = join(outDir, `${runId}-failure.png`)
    try {
      await page.screenshot({ path, fullPage: false, timeout: Math.min(timeout, 5000) })
      report.screenshots.push(path)
      emitPath(path)
    } catch { report.failureScreenshotUnavailable = true }
    throw new UserError(`UI flow failed at step ${currentStep?.index ?? 0}; report: ${reportPath}`)
  } finally {
    try { await stopTrace() } catch { report.traceUnavailable = true }
    await context.close().catch(() => {})
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
    note(`REPORT ${reportPath}`)
  }

  if (shotIndex === 0) {
    note('Varoitus: flow ei ottanut yhtään kuvaa (lisää askel jossa on "shot").')
  }
}

// ---------------------------------------------------------------------------------
// Yhden kuvan ajo
// ---------------------------------------------------------------------------------

async function runSingle(args, ctx) {
  const { browser, session, deviceRegistry, outDir, timeout, delay } = ctx
  const rawUrl = args._[0]
  const url0 = new URL(normalizeUrl(rawUrl)).toString()

  const vp = resolveViewport(
    {
      device: typeof args.device === 'string' ? args.device : undefined,
      width: args.width,
      height: args.height,
      dpr: args.dpr,
      mobile: args.mobile !== undefined ? boolFlag(args.mobile) : undefined,
    },
    deviceRegistry,
  )

  const statePath = typeof args.state === 'string' ? resolve(args.state) : null
  const persisted = statePath ? await loadStateFile(statePath) : null

  const waitSelector = typeof args['wait-selector'] === 'string' ? args['wait-selector'] : null
  const postDelay = posNum(args['post-delay'], 0)
  const clicks = asStringList(args.click)
  const measures = asStringList(args.measure)

  let injectScript = typeof args.eval === 'string' ? args.eval : null
  if (typeof args['eval-file'] === 'string') {
    injectScript = await readFile(args['eval-file'], 'utf-8')
  }

  const namePart = typeof args.name === 'string' ? slug(args.name) : slug(new URL(url0).hostname)
  const outPath = join(outDir, `${namePart}-${Date.now()}.png`)

  const context = await createContext(browser, vp, session, persisted, url0)
  try {
    const { page } = await openPage(context, url0, timeout)
    await settle(page, timeout, 0)

    if (waitSelector) await page.waitForSelector(waitSelector, { timeout })

    // Pieni lisäviive client-renderöinnin / hydraation viimeistelyyn.
    if (delay > 0) await page.waitForTimeout(delay)

    // Injektoidut toiminnot ennen kuvaa (esim. avaa valikko/modaali): ensin klikkaukset,
    // sitten mahdollinen oma JS sivun kontekstissa.
    for (const sel of clicks) await page.click(sel, { timeout })
    if (injectScript) {
      // Kääritään async-IIFE:hen, jotta injektoitu skripti voi käyttää awaitia.
      await page.evaluate(`(async () => { ${injectScript}\n})()`)
    }
    if (postDelay > 0) await page.waitForTimeout(postDelay)

    if (typeof args['scroll-to'] === 'string') {
      await page.evaluate((sel) => {
        document.querySelector(sel)?.scrollIntoView({ block: 'center' })
      }, args['scroll-to'])
      await page.waitForTimeout(300)
    }

    for (const sel of measures) {
      note(`MEASURE ${JSON.stringify(await measureElement(page, sel))}`)
    }

    await capture(page, outPath, {
      clipSelector: typeof args['clip-selector'] === 'string' ? args['clip-selector'] : null,
      clipPadding: posNum(args['clip-padding'], 16),
      viewportOnly: boolFlag(args['viewport-only']),
    })

    if (statePath) await saveStateFile(context, page, statePath)
    emitPath(outPath)
  } finally {
    await context.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------

const USAGE =
  'Käyttö: node screenshot.mjs <url> [--name nimi] [--wait-selector sel]\n' +
  '        [--device "iPhone 14"] [--width 1280] [--height 900] [--mobile] [--dpr 2]\n' +
  '        [--viewport-only] [--timeout 30000] [--delay 800] [--channel chrome|msedge]\n' +
  '        [--click sel ...] [--eval "js"] [--eval-file polku] [--post-delay ms]\n' +
  '        [--scroll-to sel] [--clip-selector sel] [--clip-padding 16] [--measure sel ...]\n' +
  '        [--cookie nimi=arvo ...] [--local-storage avain=arvo ...]\n' +
  '        [--session-storage avain=arvo ...] [--storage-file polku] [--state polku.json]\n' +
  '   tai: node screenshot.mjs --flow polku.json\n' +
  '   tai: node screenshot.mjs --list-devices\n' +
  '\n' +
  'stdout = kuvien polut (yksi per rivi). Mittaukset ja lokit menevät stderriin.'

async function main() {
  const args = parseArgs(process.argv.slice(2))

  let chromium
  let deviceRegistry
  try {
    ;({ chromium, devices: deviceRegistry } = await import('playwright-core'))
  } catch (err) {
    note(
      'playwright-core-moduulia ei löytynyt. Asenna se kerran tämän skillin kansiossa:\n' +
        '  npm install\n' +
        `Alkuperäinen virhe: ${err?.message ?? err}`,
    )
    process.exit(3)
    return
  }

  if (args['list-devices']) {
    note(Object.keys(deviceRegistry ?? {}).join('\n'))
    return
  }

  const flowPath = typeof args.flow === 'string' ? args.flow : null
  if (!flowPath && !args._[0]) {
    note(USAGE)
    process.exit(2)
    return
  }

  let flow = null
  if (flowPath) {
    try {
      flow = JSON.parse(await readFile(flowPath, 'utf-8'))
    } catch (err) {
      note(`Flow-tiedostoa ei voitu lukea/jäsentää: ${flowPath}\n${err?.message ?? err}`)
      process.exit(2)
      return
    }
    // Flow'n suhteelliset evalFile-polut tulkitaan flow-tiedoston sijainnista.
    const base = dirname(resolve(flowPath))
    for (const s of Array.isArray(flow.steps) ? flow.steps : []) {
      if (typeof s.evalFile === 'string' && !isAbsolute(s.evalFile)) s.evalFile = join(base, s.evalFile)
    }
  } else {
    try {
      new URL(normalizeUrl(args._[0]))
    } catch {
      note(`Virheellinen URL: ${args._[0]}`)
      process.exit(2)
      return
    }
  }

  let session
  try {
    session = await collectSessionState(args)
  } catch (err) {
    note(err?.message ?? String(err))
    process.exit(2)
    return
  }

  const outDir = join(tmpdir(), 'kanban-screenshots')
  await mkdir(outDir, { recursive: true })

  const ctx = {
    session,
    deviceRegistry,
    outDir,
    timeout: posNum(args.timeout, 30000),
    delay: posNum(args.delay, 800),
    statePath: typeof args.state === 'string' ? resolve(args.state) : null,
    flowDir: flowPath ? dirname(resolve(flowPath)) : process.cwd(),
  }

  const browser = await launchBrowser(chromium, typeof args.channel === 'string' ? args.channel : null)
  ctx.browser = browser
  try {
    if (flow) await runFlow(flow, ctx)
    else await runSingle(args, ctx)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  if (err instanceof UserError) {
    // Kutsujan virhe: pelkkä syy, ei stack tracea.
    note(`Virhe: ${err.message}`)
    process.exit(2)
  }
  note(`Screenshot epäonnistui: ${err?.stack ?? err}`)
  process.exit(1)
})
