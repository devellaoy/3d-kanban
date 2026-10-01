# Hahmot, wearablet, leikkiaseet ja animaatiot: selvitys ja ideat

Takaisin [README:hen](../../README.md). Tämä on suunnitteludokumentti, ei toteutettu ominaisuus. Se
kartoittaa nykytilan koodista, ideoi pelillisiä (ei tekoälyyn liittyviä) ominaisuuksia hahmojen ympärille ja
ehdottaa kirjastot sekä toteutusjärjestyksen pieninä kanban-tehtävinä. Ennen toteutusta lue
[AGENTS.md](../../AGENTS.md), [fork.md](../fork.md) (saumat ja synkronointi) ja
[features.md](../features.md).

Tilanne tarkistettu 2026-10-01 (three 0.186.1, upstream-pohja `665aeec`).

---

## 1. Nykytila lyhyesti

### Hahmot ovat proseduraalisia, eivät GLB-malleja

- **Pelaaja** on `Person`-luokka ([`src/client/world/character.ts`](../../src/client/world/character.ts)).
  Hahmo kootaan koodissa three.js:n perusmuodoista (`CapsuleGeometry`, `SphereGeometry`,
  `TorusGeometry`), ja materiaalina on `MeshToonMaterial` ([`world/toon.ts`](../../src/client/world/toon.ts)).
  Rakenne: vartalo, pää, silmät, posket, hymy, puhuva suu ja kieli, sekä raajat. Cartoon-ääriviivat
  piirtää koko näkymälle `OutlineEffect` ([`main.ts`](../../src/client/main.ts)).
- **Luurankoa tai SkinnedMeshiä ei ole.** Raajat ovat `THREE.Group`-pivotteja (`legL/legR/armL/armR`), joita
  käännetään suoraan `rotation.x/z`-arvoilla. Myös pää (`head`) ja vartalo (`body`) ovat ryhmiä.
- **Animaatiot ovat käsin kirjoitettua koodia** `Person.update()`:ssa. Kävely on siniaalto
  (`walkPhase`), istuminen lerppaa jalat ja kädet (`sitK`), ja hyppy on kiinteä asento. Lisäksi on
  erikoistiloja, jotka kirjoittavat samoja kiertoja järjestyksessä: kahvimuki, tupakka, kortti, kirja,
  koripallo, tikat ja kirves (`ocheStep`), golf (`golfStep`), tikkaat ja palomiehen tanko, sekä toisen
  olalle tarttuminen. Tilat eivät sekoitu painoilla, vaan myöhempi koodirivi voittaa tai lerppaa
  aiemman päälle.
- **Workerit** (`Worker`, sama tiedosto) ovat oma, yksinkertaisempi papu-hahmonsa. Niiden pose-järjestelmä
  `Stance` on avainnimettyjä lukuja (`armLx`, `lean`, `look` …), jotka sekoitetaan toiminnon (`Act`) mukaan.
  Tämä on lähin olemassa oleva vastine animaatioblendaukselle.
- **Ensimmäisen persoonan kädet** ovat erillinen malli ([`world/hands.ts`](../../src/client/world/hands.ts)).
- **Koira** on ainoa riggattu hahmo. Sen mallit ovat `src/client/models/dog-*.glb` (noin 0,5 Mt kukin),
  ja ne tuotetaan Blender-skriptillä ([`blender/scripts/build_dog.py`](../../blender/scripts/build_dog.py),
  apukirjasto `aokit.py`). Mallissa on `SkinnedMesh`, luut ja klipit; koodi ajaa ne `AnimationMixer`illa
  ristiinhäivytyksellä (`FADE = 0.4`) ja klonaa ne `SkeletonUtils.clone`lla
  ([`world/models.ts`](../../src/client/world/models.ts)). Asusteet ripustetaan **socket-empty**-objekteihin
  (`socket_head`, `socket_back`, `socket_nose`, `socket_neck`) ([`world/dog.ts`](../../src/client/world/dog.ts)).
  Socket-malli ja Blender-putki ovat siis jo olemassa ja toimivat. Säännöt löytyvät tiedostosta
  [`blender/README.md`](../../blender/README.md), budjettina noin 12 000 kolmiota olentoa kohden.

### Ulkoasu ja asut

- `Look` = `{ skin, hair, style }`, kolme indeksiä listoihin `SKIN_TONES` (8), `HAIR_COLORS` (10) ja
  `HAIR_STYLES` (7) ([`src/shared/avatar.ts`](../../src/shared/avatar.ts)). Paidan väri on erillinen
  `color` (`AVATAR_COLORS`, 8 kpl, [`client/state.ts`](../../src/client/state.ts)). Palvelin puhdistaa
  arvot `sanitizeLook()`:lla.
- Hahmoeditori ([`src/client/ui/character.ts`](../../src/client/ui/character.ts)) on modaali: nimi, iho,
  hiustyyli ja -väri sekä paita. Mukana on pyörivä esikatselu, joka piirtyy omalla `WebGLRenderer`illä.
- **Asut** ([`world/costumes.ts`](../../src/client/world/costumes.ts)) ovat vain koko rakennuksen
  sesonkiteemoja (`Theme`: halloween/joulu). `Person.setCostume()` ripustaa noitahatun tai joulupukin
  hatun suoraan `head`-ryhmään ja piilottaa hiukset, jotka puskisivat läpi. Workerit muuttuvat zombeiksi
  tai tontuiksi. Pelaajakohtaista vaatetusta tai inventaariota ei ole.

### Emotet

- Kuusi emotea (`wave`, `thumbs`, `clap`, `dance`, `point`, `facepalm`) on määritelty tiedostossa
  [`src/shared/emotes.ts`](../../src/shared/emotes.ts). Valinta tapahtuu G-pyörästä
  ([`ui/emotes.ts`](../../src/client/ui/emotes.ts)) tai näppäimillä 1–6.
- `Person.emote()` näyttää emojin pään päällä, ja `emoteStep()` lerppaa käsien kierrot emotekohtaiseen
  asentoon verhokäyrällä (`emoteEnvelope`).
- Nopeutta rajoittaa `EmoteBucket` (3 peräkkäin, sitten yksi per 2 s) sekä sivulla että palvelimella.

### Heittäminen ja leikit (lähin vastine "aseille")

- Tikat ja kirves ([`src/client/throwing.ts`](../../src/client/throwing.ts),
  [`shared/bargames.ts`](../../src/shared/bargames.ts)), koripallo
  ([`shared/hoop.ts`](../../src/shared/hoop.ts), [`server/court.ts`](../../src/server/court.ts)) ja golf.
- **Malli:** heittäjä lähettää heiton parametrit (`toss`/`golf`). Jokainen sivu simuloi lennon
  deterministisesti samalla jaetulla koodilla (`hoop.ts`: `launch`, `step`, `Solid`). Palvelin pitää
  kirjaa vain siitä, kuka pitää palloa, ja rajoittaa nopeutta. Tämä on hyvä pohja ammuksille.
- Pelaajien välisiä osumia, knockbackia tai fysiikkamoottoria ei ole. Törmäys hoidetaan
  [`player.ts`](../../src/client/player.ts):n omalla AABB-`Collider`-järjestelmällä
  ([`world/office.ts`](../../src/client/world/office.ts)), jossa on kapseli (`RADIUS = 0.32`),
  painovoima ja porrasaskel.

### Synkronointi ja tallennus

- WebSocket ja JSON ([`src/client/net.ts`](../../src/client/net.ts)). Nimi, väri ja `look` kulkevat
  yhteyden query-parametreina. `move` (`x,y,z,rotY,moving`) lähtee enintään noin 15 Hz
  (`now - lastSent.at > 66` ms, [`main.ts`](../../src/client/main.ts)) ja vain kun asento muuttuu.
- Palvelin ([`src/server/server.ts`](../../src/server/server.ts)) välittää `peer.move`n vain saman
  kerroksen pelaajille (`toNeighbors`) ja pudottaa viestit, jos vastaanottajan puskuri on yli 4 Mt.
  `act`, `sit`, `carry` ja `emote` tuottavat `peer.act`/`peer.update`/`peer.emote`-viestit, ja
  `PeerInfo` ([`shared/protocol.ts`](../../src/shared/protocol.ts)) kantaa pysyvän tilan
  myöhemmin saapuville.
- Etäpelaajan sijainti lerpataan kohti viimeisintä kohdetta (`pos.lerp(r.target, dt * 12)`).
  Interpolaatiopuskuria tai aikaleimoja ei ole.
- **Tallennus:** profiili (nimi, väri, look) on vain selaimen `localStorage`ssa
  (`agent-office.profile`). Palvelimen tilit ([`server/accounts.ts`](../../src/server/accounts.ts))
  tallentavat nimen ja salasanatiivisteen, eivät ulkoasua. Tikkojen ja kirveen parhaat tulokset ovat
  nekin selaimessa.

### Suorituskyvyn lähtötaso

- Yksi `Person` on noin 20–30 meshiä (vartalo, pää, silmät, posket, raajat, kädet, hiusosat ja piilossa
  olevat propit), ja jokainen näkyvä mesh on oma draw call. `OutlineEffect` piirtää näkyvät meshit
  **kahdesti**, joten 20 pelaajaa vie helposti 800–1200 draw callia pelkkinä hahmoina.
- `InstancedMesh`iä käytetään vain kaupungissa, konfetissa ja kattobaarissa. Hahmoja ei instansoida.

---

## 2. Ideat priorisoituna

Asteikko: **V** = vaikutus (pelaajan ilo ja näkyvyys), **T** = työmäärä, **R** = riski (upstream-konfliktit,
suorituskyky, työrauhan häiriö). Kunkin arvo on 1–3 (3 = suuri). Prioriteetti on karkea arvio
V − (T + R)/2 sekä riippuvuudet.

### 2.1 Skinit ja ulkoasu

| # | Idea | V | T | R | Prio | Huomio |
|---|---|---|---|---|---|---|
| S1 | **Look v2**: lisäkentät `face` (silmät/kulmat/suu: 4–6 varianttia), `pants`, `shirtStyle` (paita/huppari/kauluspaita/raidat), `bodyType` (mittasuhteet: pituus 0,9–1,1, hartiat, vatsa) | 3 | 2 | 1 | **1** | Pelkkää proseduraalista koodia ja indeksejä langalla. Taaksepäin yhteensopiva, koska `sanitizeLook` täyttää puuttuvat oletuksilla |
| S2 | Hahmoeditori v2: välilehdet (Vartalo / Kasvot / Hiukset / Vaatteet / Asusteet), satunnaistus per osio, esikatselussa emote-testi | 3 | 2 | 1 | **1** | Laajentaa nykyistä `ui/character.ts`-modaalia. Muista ✕ ja Esc, jotka palauttavat mouse-lookiin |
| S3 | Vapaa väri (HSL-valitsin) paidalle ja hiuksille listojen lisäksi | 2 | 1 | 1 | 2 | Paita on jo vapaa hex (`COLOR_RE`), hiukset eivät |
| S4 | **Tiimiskinit**: projektin (kerroksen) värit paidan kuvioon tai rintamerkkiin, valinnainen "käytä kerroksen väriä" | 2 | 1 | 1 | 2 | Kerroksilla on jo seinä- ja lattiavärit |
| S5 | Sesonkiskinit per pelaaja (nykyinen teema on koko talon): oma valinta "pukeudu teemaan / älä" | 2 | 1 | 1 | 3 | Vaatii vain lipun ja nykyisten `costumes.ts`-osien uudelleenkäytön |
| S6 | Tilikohtainen profiili palvelimelle (sama ulkoasu kaikilla laitteilla) | 3 | 2 | 1 | **1** | Edellytys inventaariolle ja avattaville esineille, ks. luku 5 |
| S7 | GLB-pohjainen riggattu ihmishahmo (Blender + aokit, koiran tapaan) | 3 | 3 | 3 | 4 | Iso: `Person`issa on noin 1000 riviä proseduraalista animaatiota (golf, tikat, emotet…). Vasta kun animaatiotarpeet (luku 2.4) sitä vaativat |
| S8 | Avatar-tuonti (VRM / Ready Player Me -tyyppinen) | 1 | 3 | 3 | ✗ | Hylätty: tyylirikko, lisenssit per malli, ja RPM on suljettu (ks. luku 3) |

### 2.2 Wearablet

| # | Idea | V | T | R | Prio | Huomio |
|---|---|---|---|---|---|---|
| W1 | **Socket-rajapinta `Person`iin**: nimetyt kiinnityspisteet `head_top`, `face`, `back`, `shoulder_L/R`, `hand_L/R`, `waist` | 3 | 1 | 2 | **1** | Pieni sauma upstream-tiedostoon, kaikki muu fork-koodia. Sama malli kuin koiran `socket_*`-empty-objekteissa |
| W2 | Hatut: pipo, lippis, baskeri, kruunu, propellihattu (pyörii kävellessä), kuulokkeet | 3 | 1 | 1 | **1** | Proseduraalisia kuten `santaHat()`. Hiusten piilotus kuten nyt `dress()`:ssa |
| W3 | Lasit: silmälasit, aurinkolasit, monokkeli, VR-lasit | 2 | 1 | 1 | 2 | `face`-socket |
| W4 | Reput ja viitat: reppu, läppärilaukku, supersankariviitta (jousi- tai verlet-heilunta), siivet | 3 | 2 | 1 | 2 | Viitan heilunta onnistuu 4–6 luun ketjuna ja yksinkertaisella verlet-simulaatiolla, ei fysiikkamoottoria |
| W5 | **Olkalemmikit**: papukaija, kissa, kumiankka, mini-robotti, jotka idlaavat itsekseen | 3 | 2 | 1 | 2 | Pieniä riggattuja GLB:itä Blender-putkesta (kuten koira, mutta noin 2–4 k kolmiota) |
| W6 | Inventaario- ja valinta-UI: ruudukko per slotti, esikatselu, "pikavaihto" (esim. 3 tallennettua asukokonaisuutta) | 3 | 2 | 1 | 2 | Kytkeytyy hahmoeditoriin (S2) |
| W7 | Avattavat esineet: saavutukset (100 PR-mergeä → kultainen kruunu, koripallo 10 putkeen → hikinauha), tikkojen 180 → tikkahattu | 3 | 2 | 1 | 3 | Vaatii palvelinpuolen tallennuksen (S6) ja tapahtumien laskennan |
| W8 | Wearable-LOD: kaukana (> 15 m) piilotetaan pienet osat (lasit, rintamerkit), ja lemmikin animaatio pysäytetään | 2 | 1 | 1 | 2 | Halpa ja tärkeä draw callien kannalta |

### 2.3 Aseet ja leikkikalut (toimistohenkeen)

Periaate: **opt-in ja vaaraton.** Kukaan ei saa osumaa, ellei ole itse laittanut leikkitilaa päälle, eikä
mikään keskeytä terminaalin, modaalin tai istumisen aikana.

| # | Idea | V | T | R | Prio | Huomio |
|---|---|---|---|---|---|---|
| A1 | **Leikkitila-kytkin** (🎯 per pelaaja, ⚙️:ssa ja pikanäppäimellä): pois päältä = ei osumia sinuun, et voi ottaa leikkiasetta. Näkyy nimilapussa | 3 | 1 | 1 | **1** | Edellytys kaikelle muulle. `PeerInfo.play?: boolean` |
| A2 | **Rauhoitetut alueet ja tilat**: ei osumia pöytien äärellä, istuessa, avoimen modaalin tai terminaalin aikana, kokoushuoneessa tai bossin toimistossa; kerroskohtainen "hiljainen kerros" -asetus adminille | 3 | 1 | 1 | **1** | Osumat tarkistetaan uhrin päässä, joten uhrin tila ratkaisee |
| A3 | **Lumipallot / paperipallot**: E roskiksesta tai lumesta (jouluteema), heitto hiiren napilla, kaari kuten koripallossa | 3 | 2 | 1 | **1** | Uusiokäyttää `hoop.ts`:n heittoparametri- ja simulointimallia |
| A4 | Paperilennokki: liitää ja kaartaa, hauska eikä tee "vahinkoa". Osuma näyttää vain viestikuplan ("✈️ Sunny Otter tervehtii") | 3 | 2 | 1 | 2 | Voi kantaa lyhyen chat-viestin, mikä on toimistohenkinen idea |
| A5 | Vesipyssy: jatkuva suihku (partikkelit), osuma kastelee eli näkyy "märkä"-shaderina ja tippoina 10 s | 3 | 2 | 2 | 3 | Partikkelit `InstancedMesh`illä. Osumatarkistus kartiona eikä per pisara |
| A6 | Nerf-blasteri: vaahtomuoviammukset, jotka jäävät lattialle ja seiniin hetkeksi (Kenney Blaster Kit CC0 malleiksi) | 3 | 2 | 2 | 3 | Ammusten määrälle katto kerrosta kohden (esim. 40, vanhin poistuu) |
| A7 | Tyynysota: lähitaisteluheilautus loungen tyynyllä, osuma = pieni knockback ja höyheniä | 2 | 2 | 1 | 3 | Lyhyt kantama, kartio-osuma |
| A8 | Konfettitykki: ei osumaa, vain juhla (sopii merge-gongin yhteyteen) | 2 | 1 | 1 | 2 | `world/confetti.ts` on jo olemassa |
| A9 | **Osumareaktiot**: "splat"-tarra kasvoille tai vaatteisiin 5 s, horjahdus (proseduraalinen), pieni knockback (uhrin oma `PlayerController` saa impulssin, max 1,5 m/s) | 3 | 2 | 2 | 2 | Ei ragdollia alkuun, ks. A10 |
| A10 | "Ragdoll"-kaatuminen: proseduraalinen floppi (vartalo kallistuu, raajat velttoina, nousu 1,5 s:ssa) | 2 | 2 | 2 | 3 | Oikea fysiikka-ragdoll (Rapier) on hylätty toistaiseksi, ks. luku 3.5 |
| A11 | Cooldownit ja ammukset: `EmoteBucket`-tyyppinen ämpäri per ase sivulla ja palvelimella, esim. lumipallo 3 ja yksi per 1,5 s | 3 | 1 | 1 | **1** | Sama malli kuin nyt emoteissa |
| A12 | Minipelit: lumisotakierros (joukkueet = kerrokset), maalitaulut seinälle, osumatilasto viikoittain | 2 | 3 | 2 | 4 | Vasta kun perusmekaniikka on vakiintunut |

### 2.4 Animaatiot

| # | Idea | V | T | R | Prio | Huomio |
|---|---|---|---|---|---|---|
| N1 | **Pose-kerrokset `Person`iin**: kävely/juoksu/idle/istuminen/kantaminen painoina (kuten `Worker`in `Stance`), ei "viimeinen voittaa" | 3 | 2 | 2 | 2 | Juoksu (`RUN = 7.5`) on nyt sama kuin kävely nopeammin. Erillinen juoksupose ja idle-hengitys tuovat paljon |
| N2 | Lisää emoteja: istu lattialle, venyttely, kahvi-skål, kumarrus, "shrug", "high five" (kaksi pelaajaa synkronoituna), 3 tanssia | 3 | 1 | 1 | **1** | Lista `shared/emotes.ts`, pyörä skaalautuu 8–10:een. Yli sen kaksi rengasta tai sivut |
| N3 | Synkronoidut pari-emotet (high five, fist bump): pyyntö ja hyväksyntä, molemmat kääntyvät toisiaan kohti | 3 | 2 | 1 | 3 | Uusi viesti `emote.pair` |
| N4 | **Katse-IK**: pää kääntyy puhujaa, lähintä pelaajaa tai kursoria kohti (rajattu ±60°) | 3 | 1 | 1 | **1** | Proseduraalisessa mallissa vain `head.rotation.y/x`. Etäpelaajille katsesuunta tarvitaan langalle (ks. M2) |
| N5 | Käsi-IK aseille ja propeille: kaksiluinen analyyttinen IK kun käsivarsi on kaksiosainen (olkavarsi + kyynärvarsi) | 2 | 2 | 2 | 3 | Nykyinen käsi on yksi kapseli, joten tarvitaan kyynärpää-pivot (sauma `Person`iin) |
| N6 | Aseen käsittelypose: pito, tähtäys (käsi seuraa kameran pitchiä), heitto | 3 | 2 | 1 | 2 | Kuten nyt `ocheStep` |
| N7 | Askelsynkronointi: jalat eivät liu'u, eli vaiheen nopeus sidotaan todelliseen nopeuteen | 2 | 1 | 1 | 2 | `pace`-parametri on jo olemassa |
| N8 | Klippipohjainen animaatio (`AnimationMixer`) ja retargetointi CC0-kirjastoista | 3 | 3 | 3 | 4 | Vain yhdessä S7:n kanssa |

### 2.5 Moninpeli ja suorituskyky

| # | Idea | V | T | R | Prio | Huomio |
|---|---|---|---|---|---|---|
| M1 | **Interpolaatiopuskuri** (aikaleimat ja noin 100 ms viive) lerpin tilalle | 2 | 1 | 1 | 2 | Pehmeämpi liike ja edellytys osumantarkistukselle |
| M2 | Katsesuunta (`pitch`) `move`-viestiin, jolloin etäpelaajan pää ja ase osoittavat oikeaan suuntaan | 2 | 1 | 2 | 2 | Upstream-protokollan sauma |
| M3 | **Draw call -dieetti**: etäpelaajan staattiset osat yhdistetään yhdeksi meshiksi per materiaali (`BufferGeometryUtils.mergeGeometries`), ja piilossa olevat propit luodaan laiskasti | 3 | 2 | 2 | 2 | Pelaajaa kohden ~25 meshistä noin 6–8:aan |
| M4 | Hahmo-LOD: > 25 m ilman ääriviivaa ja ilman pieniä osia, > 40 m vain nimilappu ja kapseli | 2 | 2 | 1 | 3 | |
| M5 | Ammusten yhteinen `InstancedMesh`-pooli ja partikkelit instansseina | 2 | 1 | 1 | 2 | Kuten konfetti |
| M6 | Palvelimen kevyt validointi: ammuksen lähtöpiste lähellä heittäjän viimeisintä sijaintia ja nopeusrajat (kuten `throwOk` koripallossa) | 2 | 1 | 1 | 2 | |

---

## 3. Suositellut kirjastot ja hylätyt vaihtoehdot

Versiot, koot ja lisenssit on tarkistettu npm-rekisteristä, GitHubista ja virallisilta sivuilta
2026-10-01. Koot on mitattu esbuildillä minifioituna ja gzipattuna, kun `three` on external-riippuvuus.

### 3.1 Hahmon renderöinti ja ulkoasu

**Suositus: jatketaan proseduraalisella `Person`illa.** Look v2 ja wearablet (S1–W8) toteutetaan
koodissa ja tarvittaessa pieninä GLB-propeina Blender-putkesta. Uusia riippuvuuksia ei tarvita.

- Tyyli (cartoon-ääriviiva, toon-gradientti) säilyy, eikä latauskoko kasva.
- Kaikki nykyinen proseduraalinen animaatio (golf, tikat, emotet, workerien toiminnot) toimii edelleen.
- Monimutkaisemmat wearablet (lemmikki, viitta) tehdään **samalla Blender + `aokit`-putkella** kuin koira:
  riggattu GLB, `AnimationMixer`, `SkeletonUtils.clone`. Työkalut ovat jo käytössä.

| Vaihtoehto | Tila | Päätös |
|---|---|---|
| Oma riggattu ihmis-GLB (Blender 5.2 + aokit) | Putki valmiina (koira) | **Myöhemmin (S7)**, kun klippipohjaisia animaatioita oikeasti tarvitaan |
| Quaternius Ultimate Modular Men / Universal Base Characters | CC0, glTF, modulaariset osat | Varavaihtoehto S7:lle, jos oma malli on liian työläs. Tyyli on lähellä, mutta ääriviiva ja toon on sovitettava |
| KayKit Adventurers (Kay Lousberg) | CC0, riggattu ja animoitu, 25+ asustetta | Sama kuin edellä. Hyvä referenssi socket-nimeämiselle |
| Kenney Mini Characters | CC0, animoitu | Tyyliltään lähin ("mini"), mutta hahmojen määrä ja formaatit jäivät varmistamatta |
| `@pixiv/three-vrm` 3.5.5 (MIT, ~37 KB gz) | Aktiivinen | **Hylätty**: anime-tyyli ei sovi, ja jokaisella VRM-mallilla on oma lisenssinsä (VRM Public License: avatarkäyttö ja kaupallinen käyttö vain jos tekijä sallii) |
| Ready Player Me | **Suljettu 2026-01-31** (Netflix osti 12/2025) | **Hylätty** |
| Avaturn / MetaPerson (Avatar SDK) | Toiminnassa, maksullinen (Pro noin $800/kk) | **Hylätty**: hinta, toimittajariski, valokuvarealistinen tyyli |

### 3.2 Animaatio ja IK

**Suositus: proseduraalisille hahmoille ei tarvita kirjastoa.** Pose-kerrokset (N1) tehdään omana
pienenä moduulinaan `Worker`in `Stance`-mallin pohjalta. Katse-IK (N4) on kaksi kulmaa ja raja-arvot, ja
käsi-IK (N5) analyyttinen kaksiluinen ratkaisu (noin 40 riviä).

Kun ja jos siirrytään riggattuihin GLB-hahmoihin (S7/N8):

| Kirjasto | Versio, lisenssi, koko | Päätös |
|---|---|---|
| three `AnimationMixer` (core) + `GLTFLoader` (14 KB gz) + `SkeletonUtils` (`clone`, `retargetClip`, 1,6 KB gz) | three 0.186.1, MIT | **Suositus.** Jo käytössä koiralla. Ristiinhäivytys, painot, additiiviset klipit |
| three `CCDIKSolver` (addon, 1,8 KB gz) | MIT | **Suositus** riggattujen hahmojen käsi- ja katse-IK:hon |
| Quaternius Universal Animation Library 1 ja 2 | CC0, 120+ ja 130+ animaatiota yhteiselle rigille, GLB | **Suositus** klippilähteeksi. Retargetointi `SkeletonUtils.retargetClip`illä tai Blenderissä |
| KayKit Character Animations | CC0, 133 animaatiota | Vaihtoehto edelliselle |
| Mixamo | Ilmainen Adobe ID:llä, rojaltivapaa pelikäytössä; raakatiedostoja ei saa jakaa erikseen | **Toissijainen**: käytännössä ylläpitämätön (katkoksia 2025–2026), ja raakatiedostojen jakorajoitus sopii huonosti avoimeen repoon. CC0-kirjastot ovat turvallisempia |
| Cascadeur 2026.2 | Ilmaisversio **ei kaupalliseen käyttöön**, Indie $96/v | Vain jos omia klippejä tehdään paljon |
| `three-ik` (THREE.IK) 0.1.0 | Viimeksi julkaistu 2018 | **Hylätty**: hylätty projekti |

### 3.3 Fysiikka, osumat ja ragdoll

**Suositus: ei fysiikkamoottoria.**

- Ammukset simuloidaan jaetulla deterministisellä koodilla kuten koripallo (`shared/hoop.ts`: oma
  painovoima, `Solid`-törmäykset ja kimpoaminen).
- Pelaajaosumat tarkistetaan ammus vastaan pystykapseli -testillä (säde 0,32, korkeus 1,7, samat
  vakiot kuin `player.ts`:ssä).
- Knockback on uhrin oman kontrollerin impulssi, ja kaatuminen proseduraalinen (A10).

| Kirjasto | Versio, lisenssi, koko | Päätös |
|---|---|---|
| Oma (hoop.ts-malli + kapselitesti) | – | **Suositus** |
| `three-mesh-bvh` 0.9.15 (MIT, ~30 KB gz) | Aktiivinen | **Valinnainen**: hyödyllinen, jos ammusten pitää osua tarkasti GLB-propeihin tai kaupungin geometriaan (`shapecast`, nopea raycast). Nykyiset AABB-`Collider`it riittävät toimistossa |
| `@dimforge/rapier3d-compat` 0.21.0 (Apache-2.0) | Julkaisuja tulee; vanha `rapier.js`-repo on arkistoitu ja kehitys jatkuu monorepossa | **Hylätty toistaiseksi**: wasm noin **1,65 Mt gz** (compat, base64) tai 1,17 Mt gz erillisenä. Kaksinkertaistaisi latauksen leikkiominaisuuden vuoksi. Nivelet (spherical/revolute) ja `KinematicCharacterController` ovat hyvät, mutta valmista ragdoll-apuria ei ole. Jos oikea ragdoll joskus halutaan, Rapier ladataan **laiskasti** (`import()`) vasta leikkitilassa |
| `jolt-physics` 1.1.0 (MIT, wasm ~742 KB gz) | Aktiivinen | Hylätty samasta syystä; Rapierin vaihtoehto, jos se tulee ajankohtaiseksi (ragdoll-tuki varmistamatta) |
| `cannon-es` 0.20.0 (MIT, ~36 KB gz) | Viimeisin julkaisu 2022-08, käytännössä ylläpitämätön | **Hylätty** |

### 3.4 Assetit ja putki

| Työkalu tai lähde | Versio, lisenssi | Päätös |
|---|---|---|
| Blender 5.2 LTS + glTF-exporter + `blender/scripts/aokit.py` | Apache-2.0 (exporter) | **Suositus**: olemassa oleva putki. Jokainen uusi malli on skripti ja `.glb` sekä `tests/<name>-model.test.ts` |
| `@gltf-transform/cli` 4.5.1 | MIT | **Suositus** jälkikäsittelyyn (dedup, prune, meshopt), jos mallien koko kasvaa |
| meshoptimizer / `gltfpack` 1.3.0 + three `MeshoptDecoder` (~7 KB gz) | MIT | **Suositus** geometrian pakkaukseen. Kevyempi kuin Draco |
| Draco (`DRACOLoader` + wasm ~63 KB gz) | Apache-2.0, viimeisin julkaisu 2024 | Hylätty: meshopt on kevyempi |
| KTX2 / Basis (`KTX2Loader` + transcoder ~245 KB gz) | Apache-2.0 | **Ei tarvita**: toon-tyyli käyttää värimateriaaleja eikä tekstuureja |
| Kenney Blaster Kit / Toy Car Kit | CC0, glTF mukana | **Suositus** nerf- ja vesipyssyreferensseiksi tai suoraan malleiksi (maalataan materiaalinimillä, ks. blender/README.md sääntö 2) |
| Quaternius / KayKit -paketit | CC0 | Referenssi ja varavaihtoehto (ks. 3.1–3.2) |
| Poly Pizza, Sketchfab | Mallikohtainen CC0 tai **CC-BY 4.0** | Vain CC0-mallit. CC-BY vaatii tekijämaininnan, joka kulkee assetin mukana, joten vältetään |

### 3.5 Instansointi ja verkko

| Kirjasto | Versio, lisenssi, koko | Päätös |
|---|---|---|
| three `InstancedMesh` / `BatchedMesh` (core) | – | **Suositus** ammuksille, partikkeleille ja pudonneille nerf-ammuksille. `BatchedMesh` ei tue skinnausta |
| `BufferGeometryUtils.mergeGeometries` (addon) | – | **Suositus** M3:een (etäpelaajan staattiset osat) |
| `@three.ez/instanced-mesh` (InstancedMesh2) 0.3.16 | MIT, ~18 KB gz, aktiivinen | Ei nyt: hyödyllinen vasta kymmenille riggatuille hahmoille (tukee instansoitua skinnausta). Toimistossa on noin 10–50 hahmoa, joille tavallinen `SkinnedMesh` riittää |
| `three-vat` 4.2.0 | MIT, repo luotu 2026-09 | **Hylätty**: liian tuore |
| `@geckos.io/snapshot-interpolation` 1.1.1 | BSD-3-Clause, ~3 KB gz, hiljainen (viimeksi 2025-02) | Referenssi. Puskuri kirjoitetaan itse (noin 60 riviä), jotta se sopii nykyiseen `peer.move`-viestiin |

---

## 4. Moninpelisynkronointi ja suorituskyky: suunnitelma

### Mitä langalla liikkuu (ehdotus)

- **Ulkoasu:** `Look` laajenee (S1), ja varustus kulkee indekseinä:
  `loadout: { head?: n, face?: n, back?: n, shoulder?: n, hand?: n }`, viitaten jaettuun luetteloon
  `src/shared/avatar/items.ts` (fork-koodia). Kulkee `profile`-viestissä ja `PeerInfo`ssa. Palvelin puhdistaa
  sen kuten `sanitizeLook` ja tarkistaa, että esine on pelaajalla avattuna (W7).
- **Leikkitila:** `PeerInfo.play?: boolean` ja viesti `play.set`.
- **Ammus:** `{ t: 'play.throw', kind, x, y, z, vx, vy, vz, seq }`. Kaikki sivut simuloivat lennon
  deterministisesti (hoop-malli). Palvelin tarkistaa ämpärin (A11), lähtöpisteen etäisyyden heittäjän
  viimeisimmästä sijainnista ja nopeuden ylärajan (M6), ja välittää viestin `toNeighbors`-tyylisesti.
- **Osuma:** **uhrin sivu** päättää osumasta (se tuntee oman tarkan sijaintinsa, leikkitilansa ja
  rauhoitusalueensa) ja lähettää `play.hit { by, seq }`. Palvelin tarkistaa, että `seq` on olemassa ja
  tuore, ja lähettää reaktion kaikille. Näin kukaan ei voi "ampua" toista, joka ei ole leikissä, eikä
  latenssi aiheuta virheosumia ruudulla, jolla uhri jo väisti.
- **Katsesuunta:** `pitch` `move`-viestiin (M2), jolloin pää ja ase osoittavat oikein.

### Kapasiteetti ja budjetit

- Kerroksella on käytännössä 2–20 ihmistä ja 0–30 workeria. Tavoite on 60 fps kannettavalla, kun
  kerroksella on 20 pelaajaa ja 20 workeria.
- **Draw callit:** nyt noin 25 meshiä pelaajaa kohden, kahdesti ääriviivan vuoksi. M3:n jälkeen tavoite on
  ≤ 8 per etäpelaaja ja wearableja kohden 1 per materiaali. Wearablet yhdistetään hahmon staattiseen
  meshiin, kun ne eivät liiku itsenäisesti.
- **Ammukset:** yksi `InstancedMesh` per ammustyyppi, katto noin 40 kerrosta kohden.
- **Verkko:** `move` noin 15 Hz × 20 pelaajaa noin 300 viestiä/s vastaanottajaa kohden (JSON noin 80 B),
  joten noin 25 KB/s. Ammukset lisäävät satunnaisia piikkejä, jotka ämpäri rajaa. Binäärikoodaus ei ole
  tarpeen tällä mittakaavalla.
- Mittaus: `renderer.info.render.calls` lab-sivulle tai `?debug`-paneeliin ennen ja jälkeen M3:n.

---

## 5. Tallennus: mitä tallennetaan per käyttäjä

Nyt profiili on vain `localStorage`ssa. Ehdotus (S6):

| Tieto | Missä | Huomio |
|---|---|---|
| Nimi | Tili (on jo) | |
| Look v2, paidan väri, valittu loadout, 3 tallennettua asukokonaisuutta | Palvelin: `<data>/profiles.json` tiliä kohden (fork-tiedosto); vierailla edelleen `localStorage` | Yhteys lähettää yhä query-parametrit. Palvelin korvaa ne tilin profiililla, jos sellainen on |
| Avatut esineet ja saavutuslaskurit (PR-mergejä, korikset putkeen, tikkojen 180) | Palvelin, sama tiedosto | Palvelin laskee tapahtumat itse (merge-gong, `court.ts`), ei luota sivuun |
| Leikkitila-asetus | Palvelin (tili) tai `localStorage` | Oletuksena pois päältä |
| Tikkojen ja kirveen ennätykset | Valinnaisesti siirto palvelimelle | Nyt selaimessa |
| Osumatilastot | Vain istunnon ajan, valinnainen viikkotaulu (A12) | Ei pysyvää "kill countia", koska se ei sovi toimistohenkeen |

---

## 6. Ehdotettu toteutusjärjestys (yksi rivi = yksi kanban-tehtävä)

Kukin on erikseen mergettävissä ja testattavissa. Jokaiseen kuuluu `npm run typecheck`, `npm test`,
`npm run build`, headless-kuvakaappaus visuaalisista muutoksista sekä README:n ja
[features.md](../features.md)/[controls.md](../controls.md):n päivitys (AGENTS.md).

**Vaihe A: perusta**

1. **Fork-hakemisto ja saumasopimus**: lisätään `src/{client,shared,server}/avatar/` ja
   `tests/avatar-*.test.ts` AGENTS.md:n ja fork.md:n fork-koodilistaan. Ei toiminnallisia muutoksia.
2. **Socket-rajapinta `Person`iin (W1)**: `Person.socket(name)` palauttaa nimetyn `Object3D`:n. Sauma
   `character.ts`:ään ja fork.md-rivi. Testi tarkistaa, että socketit ovat oikeissa kohdissa.
3. **Tilikohtainen profiili (S6)**: `profiles.json`, luku ja kirjoitus `profile`-viestistä sekä yhteyden
   avauksessa. Sauma `server.ts`:n `profile`-caseen ja yhteyden luontiin.
4. **Look v2 (S1)**: kasvot, housut, paitatyyli ja vartalotyyppi. `sanitizeLook` täyttää oletukset;
   taaksepäin yhteensopiva.
5. **Hahmoeditori v2 (S2)**: välilehdet ja satunnaistus per osio (✕ + Esc → mouse-look).

**Vaihe B: wearablet**

6. **Esineluettelo ja loadout langalla**: `shared/avatar/items.ts`, `PeerInfo.loadout`, palvelimen
   puhdistus.
7. **Ensimmäiset 6 hattua ja 3 lasit (W2, W3)** proseduraalisesti; hiusten piilotus siirtyy
   esinekohtaiseksi lipuksi.
8. **Inventaario-UI (W6)** editorin välilehdeksi, sekä asukokonaisuuksien tallennus.
9. **Wearable-LOD ja yhdistetyt meshit (W8, M3)** sekä draw call -mittaus ennen ja jälkeen.
10. **Reppu ja viitta (W4)**: viitan verlet-ketju.
11. **Olkalemmikki (W5)**: `blender/scripts/build_pet_parrot.py`, `.glb`, mallitesti ja idle-klipit.

**Vaihe C: animaatiot**

12. **Katse-IK (N4)**: oma hahmo kursoria kohti, muut lähintä puhujaa kohti. `pitch` `move`-viestiin (M2).
13. **Pose-kerrokset (N1)**: idle-hengitys, erillinen juoksupose ja askelsynkronointi (N7).
14. **Uudet emotet (N2)**: 4 emotea ja 2 tanssia, pyörä 10 paikalle.
15. **Pari-emotet (N3)**: high five ja fist bump.

**Vaihe D: leikkikalut**

16. **Leikkitila ja rauhoitusalueet (A1, A2)**: kytkin, nimilapun merkki, aluetarkistus.
17. **Interpolaatiopuskuri (M1)** etäpelaajille.
18. **Ammusmoottori**: jaettu deterministinen simulaatio (hoop-mallin yleistys), `play.throw`/`play.hit`,
    ämpäri (A11), palvelimen validointi (M6) ja `InstancedMesh`-pooli (M5).
19. **Lumi- ja paperipallot (A3)** sekä osumareaktiot (A9: splat ja horjahdus, knockback).
20. **Paperilennokki viestillä (A4).**
21. **Konfettitykki (A8).**
22. **Nerf (A6)** ja **vesipyssy (A5)**, kumpikin omana tehtävänään.
23. **Proseduraalinen kaatuminen (A10).**

**Vaihe E: myöhemmin ja harkinnan mukaan**

24. Avattavat esineet ja saavutukset (W7).
25. Selvitys: riggattu ihmis-GLB + Quaternius UAL -retargetointi (S7, N8) prototyyppinä lab-sivulla,
    jossa mitataan latauskoko, draw callit ja kuinka suuri osa `Person`in proseduraalisista toiminnoista
    pitäisi kirjoittaa uudelleen. Päätös vasta tämän jälkeen.
26. Minipelit (A12).

---

## 7. Fork-saumat (ks. [fork.md](../fork.md))

Tavoite on, että lähes kaikki uusi koodi on uusissa fork-tiedostoissa (`src/*/avatar/**`), ja
upstream-tiedostoihin tulee vain pieniä, `3d-kanban`-kommentilla merkittyjä saumoja, kukin omalle
rivilleen fork.md:n taulukkoon.

| Upstream-tiedosto | Tarvittava sauma | Tehtävät | Konfliktiriski |
|---|---|---|---|
| `src/client/world/character.ts` | `Person`: socket-objektit konstruktorissa ja `socket()`-getteri; koukku `update()`:n loppuun (`onPose?.(dt)`), jolla fork-moduuli ajaa katse-IK:n, pose-kerrokset ja asereaktiot; kyynärpää-pivot (N5) on isompi muutos | 2, 12, 13, 19, 23 | **Suuri**: 2288 riviä, ja upstream muuttaa tiedostoa usein. Pidä sauma minimissä ja logiikka fork-moduulissa |
| `src/shared/avatar.ts` | `Look`-tyypin laajennus tai erillinen `LookV2` fork-tiedostossa, jota `sanitizeLook` kutsuu | 4 | Keskisuuri. Vaihtoehto: `Look` ennallaan ja uudet kentät erillisessä `style`-objektissa, jolloin sauma on vain yksi kenttä `PeerInfo`ssa |
| `src/shared/protocol.ts` | `PeerInfo.loadout?`, `.play?`, `.style?`; `ClientMsg`/`ServerMsg`: `play.*`-viestit fork-tyyppinä (`import type { PlayMsg }`); `move.pitch?` | 6, 12, 16, 18 | Keskisuuri. Sama tapa kuin `WorkerInfo.kanban` |
| `src/server/server.ts` | `handleMessage()`:n alkuun `if (isPlayMsg(msg)) return play.handleWs(…)` (kuten `isKanbanMsg`); `profile`-case ja yhteyden luonti lukevat tilin profiilin; `move`-case välittää `pitch`n | 3, 12, 16, 18 | Keskisuuri, ja kuvio on tuttu |
| `src/client/main.ts` | `peer.*`-käsittelijät välittävät loadoutin ja leikkitilan; `move`-lähetys kantaa `pitch`n; etäpelaajien liikepäivitys interpolaatiopuskurin kautta; aseen syöte (hiiren nappi leikkitilassa, kuten koripallo) | 6, 12, 16–19 | **Suuri**, koska tiedosto on iso ja muuttuu usein. Kokoa fork-logiikka yhteen `installAvatar(…)`-kutsuun |
| `src/client/ui/character.ts` | Editori v2: joko välilehdet saumana tai koko modaali korvataan fork-versiolla, jota kutsutaan samasta kohdasta | 5, 8 | Keskisuuri. Korvaus yhdellä import-saumalla on siistimpi |
| `src/shared/emotes.ts`, `src/client/ui/emotes.ts` | `EMOTES`-listan jatko (`...FORK_EMOTES`), pyörän geometria yli 6 emotelle | 14, 15 | Pieni |
| `src/client/world/costumes.ts` | Ei muutoksia. Uudet wearablet tehdään fork-tiedostoissa, ja sesonkihatut käytetään sellaisenaan | 7 | – |
| `src/client/player.ts` | Knockback-impulssi `PlayerController`iin (`push(vx, vz)`) | 19 | Pieni |
| `src/client/state.ts` | `Profile`-tyyppiin loadout ja leikkitila (vierailla `localStorage`) | 6, 16 | Pieni |
| `docs/features.md`, `docs/controls.md`, `README.md` | "*In 3d-kanban*" -kappaleet kuten nyt | kaikki | Pieni |

Upstreamin synkronointia ajatellen kannattaa ensin tehdä tehtävät 1–2 ja tarkistaa, onko upstreamissa tullut
hahmoihin liittyviä muutoksia (`git log upstream/main -- src/client/world/character.ts`), ennen kuin
socket-saumaa laajennetaan.

---

## 8. Lähteet

- three.js r186 -julkaisu: https://github.com/mrdoob/three.js/releases/tag/r186
- three-mesh-bvh: https://github.com/gkjohnson/three-mesh-bvh
- @pixiv/three-vrm: https://github.com/pixiv/three-vrm · VRM-lisenssi 1.0: https://vrm.dev/en/licenses/1.0/
- Ready Player Me -kauppa ja sulkeminen:
  https://variety.com/2025/digital/news/netflix-acquires-ready-player-me-games-avatar-creation-1236612915/ ·
  https://en.wikipedia.org/wiki/Ready_Player_Me ·
  https://avatarsdk.com/blog/2026/01/15/switch-from-ready-player-me-to-avatar-sdk-fast-familiar-production-ready/ ·
  avatar-alustojen tila 2026 (toimittajan blogi, voi olla puolueellinen):
  https://avatarsdk.com/blog/2026/08/31/avatar-platforms-2026-whos-alive-whos-gone/
- Mixamo: https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html ·
  https://www.licenseorg.com/guide/3d-assets/mixamo ·
  https://community.adobe.com/questions-696/mixamo-is-not-end-of-life-it-s-broken-and-fixable-589870
- Quaternius: https://quaternius.com/packs/universalanimationlibrary.html ·
  https://quaternius.com/packs/universalanimationlibrary2.html ·
  https://quaternius.com/packs/ultimatemodularcharacters.html ·
  https://quaternius.com/packs/modularcharacteroutfitsfantasy.html
- Kenney: https://kenney.nl/assets/mini-characters · https://kenney.nl/assets/blaster-kit ·
  https://kenney.nl/assets/toy-car-kit
- KayKit: https://kaylousberg.itch.io/kaykit-adventurers ·
  https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 ·
  https://kaylousberg.itch.io/kaykit-character-animations
- Poly Pizza: https://poly.pizza/ · Sketchfab-lisenssiohjeet: https://sketchfab.com/developers/download-api/guidelines
- Rapier: https://github.com/dimforge/rapier/tree/master/bindings/typescript · (arkistoitu) https://github.com/dimforge/rapier.js
- cannon-es: https://github.com/pmndrs/cannon-es · JoltPhysics.js: https://github.com/jrouwe/JoltPhysics.js
- glTF-Transform: https://github.com/donmccurdy/glTF-Transform · meshoptimizer: https://github.com/zeux/meshoptimizer ·
  Draco: https://github.com/google/draco · KTX-Software: https://github.com/KhronosGroup/KTX-Software
- Blender 5.2: https://www.blender.org/download/releases/5-2/ · glTF-Blender-IO: https://github.com/KhronosGroup/glTF-Blender-IO
- Cascadeur: https://cascadeur.com/plans · https://cascadeur.com/help/faq
- THREE.IK: https://github.com/jsantell/THREE.IK
- InstancedMesh2: https://github.com/agargaro/instanced-mesh · three-vat: https://github.com/MikeFernandez-Pro/three-vat
- snapshot-interpolation: https://github.com/geckosio/snapshot-interpolation

Varmistamatta jäivät: Mixamon FAQ:n tarkka sanamuoto (sivu palautti 403), Kenney Mini Charactersin
hahmomäärä ja formaatit, VRM-spesifikaation oma lisenssi, Joltin ragdoll-rajapinta sekä hinnat, jotka ovat
peräisin toimittajan blogista.
