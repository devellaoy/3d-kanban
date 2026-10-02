# Toimiston ja pelin ominaisuusideat

Suunnittelu- ja selvitysdokumentti, ei toteutusta. Takaisin: [README](../../README.md) ·
[Features](../features.md) · [Controls](../controls.md) · [Maps](../maps.md) · [Fork notes](../fork.md).

*Kirjoitettu 2026-10-01 haaran `main` (4b812ae) pohjalta. Kirjastojen versiot ja päivämäärät on
tarkistettu npm-rekisteristä samana päivänä.*

## Rajaus

Mukana: maailma ja ympäristö, minipelit ja aktiviteetit, sosiaalisuus, liikkuminen ja ohjaus, ääni
ja tunnelma sekä tekninen pohja (fysiikka, verkko, suorituskyky, saavutettavuus).

Ei mukana (omat suunnittelutehtävänsä jonossa): tekoälyominaisuudet, hahmojen skinit, wearablet,
aseet ja UI-tyylit. Siksi tässä ei ehdoteta esimerkiksi uusia vaatteita, hattuja tai HUD-teemoja,
eikä mitään, mikä nojaa agentteihin tai kielimalleihin.

## 1. Nykytila lyhyesti

Kartoitettu koodista ([`src/client/`](../../src/client), [`src/client/world/`](../../src/client/world),
[`src/client/ui/`](../../src/client/ui)) ja [features.md](../features.md):sta, jotta ideat eivät toista
olemassa olevaa.

**Maailma ja ympäristö**

- Kerros per projekti, pinottuna torniksi ([`world/tower.ts`](../../src/client/world/tower.ts),
  [`world/stack.ts`](../../src/client/world/stack.ts)); hissi kerrosten, autotallin ja katon välillä
  ([`world/elevator.ts`](../../src/client/world/elevator.ts)).
- Toimisto ([`world/office.ts`](../../src/client/world/office.ts)): pomon parvi ja kaukoputki
  ([`telescope.ts`](../../src/client/telescope.ts)), lasinen kokoushuone, lounge, keittiö, parveke,
  koira ([`world/dog.ts`](../../src/client/world/dog.ts)), kirjahylly, pöytäkyltit, *Room to grow*
  -takahuone ja säkkituolit.
- Ulkona: katu, autotalli ja parkkipaikka ([`world/outside.ts`](../../src/client/world/outside.ts)),
  1,4 km:n maisemalenkki maatiloineen, metsineen, järvineen, rantoineen, laitureineen ja majakoineen
  ([`world/scenic.ts`](../../src/client/world/scenic.ts)), kattobaari ja kaupunki
  ([`world/rooftop.ts`](../../src/client/world/rooftop.ts), [`world/city.ts`](../../src/client/world/city.ts)).
- Kartat: toimisto, linna ja vankityrmä sekä omat JSON-kartat
  ([`world/castle.ts`](../../src/client/world/castle.ts), [`world/dungeon.ts`](../../src/client/world/dungeon.ts),
  [maps.md](../maps.md)).
- Päivä–yö-sykli (vuorokausi tunnissa), sää (aurinko, pilvet, sade, ukkonen, sumu, lumi talvella),
  valinnaisesti oikean kaupungin ennuste, katulamput ja ikkunavalot yöllä
  ([`world/sky.ts`](../../src/client/world/sky.ts), [`src/server/sky.ts`](../../src/server/sky.ts)).
  Vuodenaika vaikuttaa vain sään todennäköisyyksiin, ei maisemaan.
- Halloween- ja joulukoristelu ([`world/holiday.ts`](../../src/client/world/holiday.ts)).
- Sisustus: kuvat seinille ([`hanging.ts`](../../src/client/hanging.ts), [`ui/decor.ts`](../../src/client/ui/decor.ts)),
  pöytäkyltit (**L**). Varsinaista huonekalujen siirtelyä tai rakennustilaa ei ole.

**Minipelit ja aktiviteetit**

- Golf parvekkeelta ([`golf.ts`](../../src/client/golf.ts)), koripallo
  ([`world/hoop.ts`](../../src/client/world/hoop.ts)), tikat ja kirvesheitto katolla
  ([`throwing.ts`](../../src/client/throwing.ts), [`world/bargames.ts`](../../src/client/world/bargames.ts)).
- Superautot, kyydissä istuminen ja kierrosajat ([`driving.ts`](../../src/client/driving.ts),
  [`world/cars.ts`](../../src/client/world/cars.ts), [`laps.ts`](../../src/client/laps.ts)).
- BLOCKFALL-pelikone, jonka ennätyslista on koko rakennuksen yhteinen
  ([`ui/arcade.ts`](../../src/client/ui/arcade.ts), [`src/shared/cabinet.ts`](../../src/shared/cabinet.ts)),
  Miinaharava pomon näytöllä ([`ui/minesweeper.ts`](../../src/client/ui/minesweeper.ts)).
- Kahvi ([`caffeine.ts`](../../src/client/caffeine.ts)), drinkit ([`booze.ts`](../../src/client/booze.ts),
  [`world/drunk.ts`](../../src/client/world/drunk.ts)), tupakkatauko
  ([`world/smoke.ts`](../../src/client/world/smoke.ts)), merge-gongi ja konfetti. (Tikkaat ja paloautotangot
  poistettiin, #360.)
- Ennätykset (golf, tikat, kirves, kierrokset) ovat vain selaimen `localStorage`ssa; vain
  BLOCKFALL-ennätykset ovat palvelimella. Saavutuksia tai badgeja ei ole.

**Sosiaalisuus**

- Chat ja chat-kuplat hahmon pään päällä ([`world/character.ts`](../../src/client/world/character.ts)
  `say()`), kuusi emotea G-pyörästä tai 1–6 ([`ui/emotes.ts`](../../src/client/ui/emotes.ts)).
- Mitä kukin tekee: automaattinen rivi nimilapun alla ([`ui/whereabouts.ts`](../../src/client/ui/whereabouts.ts)),
  klikkauksella kävely kaverin luo ([`walkto.ts`](../../src/client/walkto.ts)). Käsin asetettavaa tilaa
  (fokus, tauko, poissa) ei ole.
- WebRTC-ääni ja ruudunjako ([`voice.ts`](../../src/client/voice.ts)): äänenvoimakkuus riippuu vain
  etäisyydestä (`HTMLAudioElement.volume`), ei suunnasta eikä seinistä.
- Yhteinen whiteboard (Excalidraw), kokoushuone, kuvat seinille, kutsulinkit ja tilit.

**Liikkuminen ja ohjaus**

- WASD, juoksu (Shift), hyppy, 1./3. persoona hiirikatseella ja herkkyyssäädöllä
  ([`player.ts`](../../src/client/player.ts)), istuminen, tikkaat, tanko, autot.
- Kosketusnäytöllä vain napautus ja raahaus (ei virtuaalista tikkua); puhelimelle tarjotaan
  2D-näkymä `/lite`. Ei gamepad- eikä WebXR-tukea (koodista ei löydy `getGamepads`- tai `xr`-käyttöä).

**Ääni ja tunnelma**

- Kaikki äänet syntetisoidaan Web Audiolla, ei äänitiedostoja: toimiston ambient, askeleet, sää,
  linnut ja sirkat, koira, gongi ([`sound.ts`](../../src/client/sound.ts), sijoitettu `PannerNode`illa),
  jukeboksin lo-fi ([`music.ts`](../../src/client/music.ts)) ja DJ:n drum and bass
  ([`dnb.ts`](../../src/client/dnb.ts)).

**Tekninen pohja**

- Oma liike- ja törmäyskoodi: laatikkokolliderit ja ledget ([`player.ts`](../../src/client/player.ts)),
  omat ballistiikat golfille, koripallolle ja heitoille. Ei fysiikkamoottoria.
- Verkko: oma JSON-WebSocket-protokolla ([`src/shared/protocol.ts`](../../src/shared/protocol.ts)),
  liike lähetetään enintään ~15 kertaa sekunnissa (`move` → `peer.move`), palvelin välittää
  saman kerroksen naapureille ([`src/server/server.ts`](../../src/server/server.ts)). Autoja ajaa
  kuljettajan selain ([`src/shared/garage.ts`](../../src/shared/garage.ts)).
- Toon-materiaalit ([`world/toon.ts`](../../src/client/world/toon.ts)), Blender-skripteillä tehdyt
  `.glb`-mallit ([`blender/scripts/`](../../blender/scripts), [`world/models.ts`](../../src/client/world/models.ts)),
  instansoitu konfetti ja kaupunki, `framerate.ts` tarjoaa 2D-näkymää hitaalle koneelle,
  `prefers-reduced-motion` hillitsee kameran tärähdyksiä ja humalaefektiä.

## 2. Uudet ideat ryhmiteltynä ja priorisoituna

Asteikot: **Vaikutus** (kuinka paljon tiimin arkeen tai fiilikseen) 1–3, **Työ** S (≤ 1 pv),
M (2–4 pv), L (1–2 vk), XL (> 2 vk), **Riski** (tekninen tai upstream-konflikti) matala / keski /
korkea. **Prio** P1 = tee ensin, P2 = kun pohja on, P3 = myöhemmin tai vain spike.

### 2.1 Maailma ja ympäristö

| # | Idea | Kuvaus | Vaikutus | Työ | Riski | Prio |
|---|---|---|---|---|---|---|
| W1 | Oma työpiste | Työpöydän pientavarat (kasvi, muki, valokuva, pöytälamppu, kumiankka) valitaan listasta, per pöytä ja kerros, tallennetaan kuten pöytäkyltit. Ei koske hahmoa. | 3 | M | matala | P1 |
| W2 | Rakennustila (sisustus) | Admin avaa katalogin (CC0-huonekalut, ks. luku 3.9), asettaa ja kääntää kalusteita ruudukkoon lattialla; törmäyslaatikko mallin rajoista, tallennus per kerros kuten kuvat. Kävelyruudukko (`shared/nav.ts`) päivitetään. | 3 | XL | korkea | P2 |
| W3 | Pelihuone kellariin | Autotallin taakse tai alle uusi huone hissin pysähdykseksi: pöytäjalkapallo, pingis, biljardi (M1–M3). Uusi tiedosto, hissiin yksi pysähdys. | 3 | L | keski | P2 |
| W4 | Vuodenajat maisemassa | Server/sky.ts tietää jo vuodenajan; puiden lehdet (kevään kukat, ruska, paljaat oksat), nurmen sävy ja lumipeite seuraavat sitä. | 2 | M | matala | P2 |
| W5 | Valokatkaisijat ja pöytälamput | **E** katkaisijasta sammuttaa tai himmentää alueen valot kaikille; oman pöytälampun saa päälle (W1). Yöllä tunnelma. | 2 | S | matala | P1 |
| W6 | Kasvit, jotka kasvavat mergeistä | Lounge-kasvi kasvaa joka mergetystä PR:stä ja nuupahtaa, jos viikkoon ei mergetä mitään. Kytkös gongin `merge`-tapahtumaan. | 2 | S | matala | P1 |
| W7 | Kattopuutarha / terassi | Katolle tai parvekkeelle istutuslaatikot, joita voi kastella (**E**); kasvu tallentuu palvelimelle. | 1 | M | matala | P3 |
| W8 | Lisää ulkoalueita lenkin varrelle | Leirintäpaikka nuotioineen järven rannalla, näköalapaikka vuorella. Rakentuu valmiiseen `scenic.ts`:ään. | 2 | M | matala | P3 |

### 2.2 Minipelit ja aktiviteetit

| # | Idea | Kuvaus | Vaikutus | Työ | Riski | Prio |
|---|---|---|---|---|---|---|
| M1 | Pingis | 1 v 1 pöytä loungessa tai pelihuoneessa. Pallo on ballistinen (kuten golf), lyöjän selain on pallon auktoriteetti, vuoro vaihtuu osumassa. | 3 | L | keski | P2 |
| M2 | Pöytäjalkapallo | 2 v 2, tangot hiirellä/WS:llä; pallo tarvitsee oikean fysiikan (Rapier, luku 3.1), simuloidaan isännän selaimessa ja lähetetään tilannekuvina. | 3 | L | korkea | P2 |
| M3 | Biljardi | Vuoropohjainen: lyöjän selain simuloi lyönnin Rapierilla ja lähettää lopputuloksen ja radan; muut toistavat sen. Verkko on helppo, fysiikka vaatii hiomista. | 2 | L | keski | P3 |
| M4 | Paperipallo roskikseen | Rypistä paperi pöydän ääressä ja heitä roskikseen; käyttää koripallon heittomittaria. | 2 | S | matala | P1 |
| M5 | Kalastus | Järven laiturilla ja rantalaiturilla: heitto, odotus, nykäisy ajoituksella; saaliit (kalat, saappaat) ja kalapäiväkirja. Rauhallinen tekeminen agenttien työskennellessä. | 3 | M | matala | P1 |
| M6 | Kilpa-ajot ja haamuauto | Lähtövalot kadun maalilinjalla, 2–6 kuljettajaa samaan lähtöön; oman parhaan kierroksen haamuauto; kierrosennätykset palvelimelle. | 3 | M | keski | P1 |
| M7 | Toimistotuoliralli | Istu pyörivälle toimistotuolille ja potki itseäsi käytävää pitkin; kierrosaika kerroksen ympäri. | 2 | S | matala | P2 |
| M8 | Yhteinen palapeli | Loungen pöydällä palapeli, jonka kuvan voi valita seinäkuvista; kuka tahansa siirtää paloja, tilanne säilyy päiviä. | 2 | M | matala | P2 |
| M9 | Lautapelipöytä | Shakki tai tammi vuoropohjaisena, myös asynkronisena (siirto silloin kun ehtii). Säännöt `chess.js`:llä. | 2 | M | matala | P3 |
| M10 | Pong kahdelle pelikoneella | Toinen peli BLOCKFALLin rinnalle, kaksi pelaajaa samalla koneella; käyttää valmista `ui/arcade.ts`:ää ja ennätyslistaa. | 2 | M | matala | P2 |
| M11 | Saavutukset ja badget | Palvelin tallentaa tapahtumat (hole-in-one, 180 tikoissa, ensimmäinen kala, 10 mergeä viikossa) ja myöntää badgen; näkyy profiilissa ja *In the office* -listassa, ei hahmossa. | 3 | M | matala | P1 |
| M12 | Tulostaulut ja Hall of fame | Golfin, tikkojen, kirveen, koripallon, kierrosaikojen ja kalastuksen ennätykset palvelimelle; seinätaulu toimistossa ja ikkuna ☰-valikossa. Siirtää nykyiset `localStorage`-ennätykset. | 3 | M | matala | P1 |
| M13 | Tiimihaasteet | Viikon haaste koko kerrokselle (esim. "yhteensä 20 koria", "jokainen ajaa lenkin"); edistymispalkki taululla, onnistuminen soittaa gongia. | 2 | M | matala | P2 |

### 2.3 Sosiaalisuus

| # | Idea | Kuvaus | Vaikutus | Työ | Riski | Prio |
|---|---|---|---|---|---|---|
| S1 | Tila: fokus, tauko, kokouksessa, poissa | Käsin valittava tila ☰-valikosta tai pikanäppäimellä; fokus näyttää kuulokkeet-ikonin nimilapussa ja hiljentää muiden lähiäänen sinulle. Automaattinen *poissa* N minuutin toimettomuuden jälkeen (Zzz pään päällä). | 3 | S | matala | P1 |
| S2 | Reaktiot | Nopeat emoji-reaktiot (👏 🎉 ❤️ 😂) lentävät hahmon yltä; useampi samanaikainen reaktio kasautuu (👏 ×5). Myös reaktio toisen chat-kuplaan. | 2 | S | matala | P1 |
| S3 | Tapahtumat ja kalenteri | Toistuvat tapahtumat (perjantaikahvit, demopäivä, retro): ilmoitus 5 min ennen, **Liity**-painike vie paikalle, demopäivänä kattobaarin LED-seinä näyttää ruudunjaon. | 3 | M | matala | P2 |
| S4 | Spatiaalinen puhe | Puheen suunta (HRTF-panorointi) Web Audiolla, huoneet akustisina vyöhykkeinä (kokoushuoneen lasi vaimentaa), kuiskaus lähelle ja mikrofoni/podium koko kerrokselle. | 3 | M | keski | P1 |
| S5 | Valokuvatila | HUD piiloon, vapaa kamera rajatulla säteellä, ajastin ryhmäkuvalle, tallennus PNG:nä; valinnaisesti ripustus seinälle olemassa olevalla kuvasysteemillä. | 3 | M | matala | P1 |
| S6 | Vieraat | Rajattu vieraskutsulinkki: liikkuu, juttelee ja kuulee, mutta ei avaa terminaaleja, boardeja eikä asetuksia; *vieras*-merkintä nimilapussa, vanhenee automaattisesti. | 2 | L | korkea | P3 |
| S7 | Vieraskirja / kuvaseinä | Aulan seinälle kerätään valokuvat (S5) ja tapahtumien muistot aikajärjestyksessä. | 1 | S | matala | P3 |
| S8 | High five ja kättely | Kahden pelaajan emote: toinen tarjoaa, toinen hyväksyy **E**:llä, animaatio synkronissa. | 2 | S | matala | P2 |

### 2.4 Liikkuminen ja ohjaus

| # | Idea | Kuvaus | Vaikutus | Työ | Riski | Prio |
|---|---|---|---|---|---|---|
| L1 | Gamepad | Gamepad API: vasen tikku kävelee, oikea katsoo, A hyppää, X = E; autoissa liipaisimet kaasu ja jarru. | 2 | S | matala | P1 |
| L2 | Kosketusohjaus 3D:lle | Tableteille virtuaalinen tikku (nipplejs), hyppy- ja E-painikkeet; puhelimelle 2D-näkymä pysyy oletuksena. | 2 | M | keski | P2 |
| L3 | Uinti | Järvessä ja meressä: vesi pinnan alle astuessa, hidas uintiliike, roiske-partikkelit, märkä hahmo hetken. | 2 | M | matala | P2 |
| L4 | Pienajoneuvot | Potkulauta tai polkupyörä kaupungissa ja toimiston käytävillä; samaa `rig`-mallia kuin autot. | 2 | M | matala | P3 |
| L5 | Näppäinten uudelleenmääritys | Asetuksissa jokaiselle toiminnolle oma näppäin (myös saavutettavuus, ks. T8). | 2 | M | keski | P2 |
| L6 | WebXR-katselu | Spike: istuva VR-tila (katselu ja teleporttaus), terminaalit pysyvät 2D:nä. DOM-pohjainen käyttöliittymä ei siirry VR:ään helposti. | 1 | XL | korkea | P3 |

### 2.5 Ääni ja tunnelma

| # | Idea | Kuvaus | Vaikutus | Työ | Riski | Prio |
|---|---|---|---|---|---|---|
| A1 | Huoneakustiikka | Kaiku (ConvolverNode, syntetisoitu impulssivaste) linnan saliin, autotalliin ja tyrmään; kuiva toimisto. | 2 | S | matala | P1 |
| A2 | Jukeboksin jono ja äänestys | Usea biisi jonoon, peukutus nostaa järjestyksessä; näkyy jukeboksin näytöllä. | 2 | S | matala | P2 |
| A3 | Palkintojinglet | Lyhyet syntetisoidut äänet saavutukselle, ennätykselle ja haasteen onnistumiselle (M11–M13). | 1 | S | matala | P2 |
| A4 | Kerroskohtainen ambient | Kerrokselle valittava taustaäänimaisema (kahvila, sade, metsä) hiljaisena sekoituksena. | 1 | S | matala | P3 |
| A5 | Fokusmusiikki | Oma, vain itselle kuuluva lo-fi kuulokkeisiin fokus-tilassa (S1); `music.ts`:n kappaleet. | 2 | S | matala | P2 |

### 2.6 Tekninen pohja

| # | Idea | Kuvaus | Vaikutus | Työ | Riski | Prio |
|---|---|---|---|---|---|---|
| T1 | Fork-omistettu `fun.*`-viestikanava | Uusille peliominaisuuksille yksi viestityyppien perhe ja yksi sauma `server.ts`:n switchiin (kuten `isKanbanMsg`), jotta minipelit eivät levitä muutoksia `protocol.ts`:ään. Edellytys M1–M13:lle. | 3 | M | keski | P1 |
| T2 | Palvelinpuolen pistevarasto | Tulokset, saavutukset ja haasteet SQLiteen (fork käyttää jo `better-sqlite3`:a kanbanissa); yksinkertainen uskottavuustarkistus (ei negatiivisia, ei mahdottomia arvoja). | 3 | M | matala | P1 |
| T3 | Fysiikka laiskasti ladattuna | Rapier ladataan dynaamisella `import()`:lla vasta, kun minipeli avataan; pelaajan oma liikekoodi pysyy ennallaan. | 2 | M | keski | P2 |
| T4 | Interpolointi ja tasaisempi liike | Muiden hahmojen liike puskuroituna ~100 ms ja interpoloituna; nopeus mukaan viestiin. Tarpeen pingis- ja kilpa-ajotarkkuudelle. | 2 | M | keski | P2 |
| T5 | BVH-raycastit | `three-mesh-bvh` raskaille raycasteille (tähtäys, kuvan ripustus, kalastussiima, rakennustila). | 2 | S | matala | P2 |
| T6 | Suorituskykymittari ja adaptiivinen DPR | `renderer.info` (draw callit, kolmiot) kehittäjäpaneeliin; `setPixelRatio` laskee automaattisesti ennen kuin `framerate.ts` tarjoaa 2D-näkymää. | 2 | S | matala | P1 |
| T7 | Mallien pakkaus | CC0-mallit meshopt/Draco + KTX2 -pakattuina (GLTFLoaderin omat dekooderit), yksi tekstuuriatlas paketista. | 1 | S | matala | P2 |
| T8 | Saavutettavuus | Visuaaliset tekstitykset tärkeille äänille (🔔 gongi, 🐕 haukku, työntekijän ding), värisokeusturvalliset tilat (antennin väri + muoto), kameran heilunnan ja humalan erillinen pois-asetus, tekstikoko. | 3 | M | matala | P1 |

## 3. Kirjastot osa-alueittain

Yleislinja: projektilla on vain kourallinen riippuvuuksia (ks. [`package.json`](../../package.json)),
ja se tekee paljon itse (äänet syntetisoidaan, mallit Blender-skripteillä). Uusi kirjasto otetaan
vain, kun se säästää selvästi työtä, ja raskaat ladataan vasta tarvittaessa.

### 3.1 Fysiikka

**Suositus: [`@dimforge/rapier3d-compat`](https://www.npmjs.com/package/@dimforge/rapier3d-compat)**
0.21.0 (Apache-2.0, julkaistu 2026-09-25). Aktiivinen, WASM-pohjainen ja nopea, valmis
[character controller](https://rapier.rs/docs/user_guides/javascript/character_controller), ja
`-compat`-versio upottaa WASMin, joten Vite ei tarvitse erillistä wasm-pluginia. Paketti on iso
(npm-paketti ~14 Mt pakkaamattomana useine buildeineen), joten se ladataan dynaamisesti vain
minipeleissä (T3). Biljardiin ja muuhun, missä usean selaimen pitäisi päätyä samaan tulokseen, on
erillinen [`@dimforge/rapier3d-deterministic-compat`](https://www.npmjs.com/package/@dimforge/rapier3d-deterministic-compat).
Pelaajan liike jätetään nykyiselle omalle koodille: se toimii, ja sen vaihtaminen koskisi upstreamin
`player.ts`:ää laajasti.

Hylätyt:

- [`cannon-es`](https://www.npmjs.com/package/cannon-es) 0.20.0 (MIT): kevyt ja puhdas JS, mutta
  viimeisin julkaisu 2022-08-12 eli käytännössä ylläpitämätön.
- [`jolt-physics`](https://www.npmjs.com/package/jolt-physics) 1.1.0 (MIT, 2026-07): erittäin
  kyvykäs, mutta API on matalan tason Emscripten-sidos manuaalisine muistinvapautuksineen; ylimitoitettu
  pöytäpeleihin.
- Ei moottoria lainkaan: riittää pingikselle ja paperipallolle (ballistiikka kuten golf), mutta ei
  pöytäjalkapalloon tai biljardiin.

### 3.2 Törmäykset, raycastit ja navigointi

**Suositus: [`three-mesh-bvh`](https://www.npmjs.com/package/three-mesh-bvh)** 0.9.15 (MIT,
2026-09-09, peer `three >= 0.159`). Nopeuttaa raycastit ja muotokyselyt monimutkaisiin meshehin;
otetaan käyttöön kohdistetusti (T5).

**Ei vielä: [`recast-navigation`](https://www.npmjs.com/package/recast-navigation) /
[`@recast-navigation/three`](https://www.npmjs.com/package/@recast-navigation/three)** 0.43.1 (MIT).
Navmesh ja polunetsintä ovat hyviä, mutta nykyinen kävelyruudukko
([`src/shared/nav.ts`](../../src/shared/nav.ts)) riittää työntekijöille ja koiralle. Arvioidaan
uudelleen rakennustilan (W2) yhteydessä, jos kalusteiden siirtely tekee ruudukosta hankalan.

### 3.3 Ääni

**Suositus: jatketaan omalla Web Audio -koodilla** ([`sound.ts`](../../src/client/sound.ts)). Se
käyttää jo `PannerNode`a ja syntetisoi kaiken. Puheen suunta (S4) tehdään samalla tavalla: WebRTC:n
`MediaStream` → `MediaStreamAudioSourceNode` → `PannerNode` (`panningModel: 'HRTF'`) samaan
`AudioContext`iin, kuuntelija päivitetään kameran mukaan. Huoneakustiikka `ConvolverNode`lla (A1).

Hylätyt:

- [`howler`](https://www.npmjs.com/package/howler) 2.2.4 (MIT): viimeisin julkaisu 2023-09-19, ja se
  on tehty äänitiedostojen soittoon; projektissa ei ole äänitiedostoja.
- three.js:n [`PositionalAudio`](https://threejs.org/docs/#api/en/audio/PositionalAudio): ohut kääre
  samaan `PannerNode`en, mutta toisi rinnakkaisen `AudioListener`/`AudioContext`-rakenteen
  `sound.ts`:n viereen. Ei lisäarvoa.

### 3.4 Ohjaus: kosketus, gamepad, VR

- **Kosketus: [`nipplejs`](https://www.npmjs.com/package/nipplejs)** 1.0.4 (MIT, 2026-05-26). Pieni,
  riippuvuudeton virtuaalitikku; katseen raahaus on jo `player.ts`:ssä. Vaihtoehto oma pointer
  events -tikku (noin 150 riviä) on myös realistinen, jos riippuvuutta halutaan välttää.
- **Gamepad: selaimen [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API)**
  ilman kirjastoa; pollataan `navigator.getGamepads()` render-loopissa.
- **VR: three.js:n oma WebXR** ([`XRButton`](https://threejs.org/docs/pages/XRButton.html),
  `renderer.xr`), jo mukana `three`-paketissa. Hylätty
  [`@react-three/xr`](https://www.npmjs.com/package/@react-three/xr): React-pohjainen, projektin
  three.js-koodi on vanilla.

### 3.5 Teksti 3D:ssä

**Suositus: [`troika-three-text`](https://www.npmjs.com/package/troika-three-text)** 0.52.5 (MIT,
2026-07-24). SDF-teksti pysyy terävänä etäältäkin; tulostauluihin (M12), haastetauluun (M13) ja
tapahtumakyltteihin. Nykyiset canvas-tekstuurit (`textSprite`, laudat) jätetään ennalleen.
Hylätty three.js `TextGeometry`: raskas geometria, fontti JSON-muodossa, ei sovi muuttuvaan tekstiin.

### 3.6 Partikkelit

**Suositus: oma instansoitu koodi** kuten [`world/confetti.ts`](../../src/client/world/confetti.ts) ja
[`world/smoke.ts`](../../src/client/world/smoke.ts) yksinkertaisille efekteille (roiske, kipinät,
reaktiot). Jos tarvitaan monimutkaisia efektejä (ilotulitus, sääpartikkelit), [`three.quarks`](https://www.npmjs.com/package/three.quarks)
0.17.1 (MIT, 2026-05-21, peer `three >= 0.182`), jossa on batch-renderöinti ja visuaalinen editori.
Hylätty toistaiseksi [`three-nebula`](https://www.npmjs.com/package/three-nebula) 13.3.0 (MIT):
aktiivinen taas 2026-09, mutta raskaampi rakenne eikä tuo mitään, mitä quarks ei tuo.

### 3.7 Verkkosynkronointi

**Suositus: nykyisen WS-protokollan laajennus** fork-omalla `fun.*`-viestiperheellä (T1),
tarvittaessa interpoloinnilla (T4). Minipelien malli: **isännän selain on auktoriteetti** (kuten
autoissa nyt), palvelin välittää ja tallentaa vain tulokset. Binäärikoodaus (esim.
[`@msgpack/msgpack`](https://www.npmjs.com/package/@msgpack/msgpack), ISC) vasta, jos mittaus näyttää
JSONin olevan pullonkaula; ~15 Hz liikeviestit pienelle tiimille eivät sitä ole.

Hylätty: [Colyseus](https://www.npmjs.com/package/colyseus) 0.18.9 (MIT, 2026-09-30). Hyvä
moninpelikehys, ja 0.18 toi [client-side predictionin ja lag compensationin](https://colyseus.io/blog/colyseus-018-is-here/),
mutta se toisi oman huone-, tila- ja autentikointimallinsa nykyisen palvelimen rinnalle (tai tilalle),
eli toisen WS-yhteyden, toisen tilin tarkistuksen ja ison sauman upstreamin `server.ts`:ään. Pienen
tiimin toimistoon hyöty ei kata kustannusta.

### 3.8 Muut

- Lautapelien säännöt: [`chess.js`](https://www.npmjs.com/package/chess.js) 1.4.0 (BSD-2-Clause).
- Jälkikäsittely (esim. valokuvatilan syväterävyys): [`postprocessing`](https://www.npmjs.com/package/postprocessing)
  6.39.5 (Zlib), vain jos three.js:n omat `EffectComposer`-passit eivät riitä.

### 3.9 3D-assetit

| Lähde | Lisenssi | Sopivat paketit | Huomio |
|---|---|---|---|
| [Kenney](https://kenney.nl/support) | CC0, ei vaadi mainintaa | Furniture Kit, Mini Arcade, Food Kit, Nature Kit | Turvallisin valinta; logoa ei saa käyttää. |
| [KayKit](https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0) (Kay Lousberg) | CC0 1.0 | [Furniture Bits](https://kaylousberg.itch.io/furniture-bits), [Restaurant Bits](https://kaylousberg.itch.io/restaurant-bits), [City Builder Bits](https://kaylousberg.itch.io/city-builder-bits) | glTF mukana, yksi gradienttiatlas: sopii toon-tyyliin hyvin. |
| [Quaternius](https://quaternius.com/) | [Quaternius Asset License v1.0](https://quaternius.com/license.html): ilmainen, ei mainintaa, **mutta assetteja ei saa jakaa erikseen** | Ultimate Furniture Pack, Ultimate House Interior, Animated Fish Pack | Julkinen MIT-repo ja npm-paketti jakaisivat `.glb`-tiedostot sellaisenaan; ei käytetä ilman erillistä varmistusta. Tarkista paketin oma lisenssitiedosto (vanhemmat paketit julkaistiin CC0:na). |
| [Poly Pizza](https://poly.pizza/) | Sekä CC0 että CC-BY 4.0, malli kerrallaan | Yksittäiset rekvisiitat | Vain CC0-malleja, tai CC-BY-mallit `docs/`-tiedostoon kirjattuine mainintoineen. |

Käytännöt: mallit ladataan [`world/models.ts`](../../src/client/world/models.ts):n kautta,
materiaalit vaihdetaan `toon.ts`:n toon-materiaaleiksi, jotta tyyli pysyy yhtenäisenä, ja
lähde, lisenssi ja paketin versio kirjataan `src/client/models/`-kansion viereen
(esim. `CREDITS.md`). Omat Blender-skriptit ([`blender/README.md`](../../blender/README.md)) pysyvät
ensisijaisina näkyville toimiston kalusteille.

## 4. Quick winit

Pieniä (≤ 1 pv), erillisiä, eivät vaadi uutta kirjastoa eivätkä T1-pohjaa (paitsi erikseen mainittu):

1. **Tila fokus / tauko / poissa** (S1): nimilappuun ikoni, automaattinen *poissa*. Kulkee nykyisen
   `whereabouts`-rivin mukana.
2. **Reaktiot** (S2): neljä emojia lisää emote-pyörään, lentävät ja kasautuvat.
3. **Paperipallo roskikseen** (M4): koripallon heittomittari, roskis jokaisen pöytärivin päähän.
4. **Kasvi, joka kasvaa mergeistä** (W6): kuuntelee gongin merge-tapahtumaa.
5. **Valokatkaisija** (W5): **E** sammuttaa loungen valot kaikilta; yöllä hauska.
6. **Gamepad** (L1): Gamepad API kävelyyn, katseeseen, hyppyyn ja E:hen.
7. **Huoneakustiikka** (A1): kaiku linnaan, autotalliin ja tyrmään.
8. **Suorituskykymittari ja adaptiivinen DPR** (T6).
9. **Äänitekstitykset** (osa T8:aa): toast tai ikoni ruudun reunalla gongille, haukulle ja dingille.

## 5. Ehdotettu toteutusjärjestys kanban-tehtävinä

Jokainen rivi on yksi pieni, erikseen mergettävä kanban-tehtävä. Jokaisessa: oma tiedosto
fork-kansioon (luku 6), mahdolliset saumat kirjataan `docs/fork.md`:hen samassa muutoksessa,
`README.md` ja `docs/features.md` / `docs/controls.md` päivitetään, ja tarkistus `npm run typecheck`,
`npm test`, `npm run build` sekä headless-kuvakaappaus. Uusissa modaaleissa ✕ oikeassa yläkulmassa ja
Esc palauttaa suoraan hiirikatseeseen (AGENTS.md).

**Vaihe 0: pohja**

1. Fork-kansio `src/client/fun/` + `src/shared/fun/` + `src/server/fun/` ja niiden lisäys
   `AGENTS.md`:n ja `docs/fork.md`:n fork-koodilistaan.
2. `fun.*`-viestit ja yksi dispatch-sauma `server.ts`:ään ja `main.ts`:ään (T1), testi viestien
   validoinnille (`tests/fun-protocol.test.ts`).
3. Pistevarasto SQLiteen ja `GET /api/fun/scores` (T2), testit.

**Vaihe 1: quick winit** (järjestys vapaa, ei riippuvuuksia toisiinsa)

4. Tila fokus / tauko / poissa (S1).
5. Reaktiot (S2).
6. Gamepad (L1).
7. Paperipallo (M4).
8. Merge-kasvi (W6).
9. Valokatkaisija (W5).
10. Huoneakustiikka (A1).
11. Suorituskykymittari ja adaptiivinen DPR (T6).
12. Äänitekstitykset ja värisokeusturvalliset tilat (T8, osa 1).

**Vaihe 2: tulokset ja yhteisöllisyys** (vaatii 2–3)

13. Golfin, tikkojen, kirveen, koripallon ja kierrosten ennätykset palvelimelle, vanhat
    `localStorage`-arvot siirretään kerran (M12, osa 1).
14. Hall of fame -seinätaulu `troika-three-text`illä ja ☰-ikkuna (M12, osa 2).
15. Saavutukset ja badget profiiliin (M11).
16. Kilpa-ajon lähtövalot ja yhteislähtö (M6, osa 1).
17. Haamuauto omasta parhaasta kierroksesta (M6, osa 2).
18. Valokuvatila ja PNG-tallennus (S5).
19. Spatiaalinen puhe: HRTF-panorointi (S4, osa 1).
20. Spatiaalinen puhe: huonevyöhykkeet ja kuiskaus (S4, osa 2).

**Vaihe 3: uudet aktiviteetit**

21. Kalastus järven laiturilla (M5, osa 1); saaliit ja päiväkirja (osa 2).
22. Oma työpiste: pientavaravalikko ja tallennus (W1).
23. Tapahtumakalenteri ja ilmoitukset (S3).
24. Tiimihaasteet (M13).
25. Jukeboksin jono (A2) ja palkintojinglet (A3).
26. Pong kahdelle (M10).
27. Uinti (L3).
28. Vuodenajat maisemassa (W4).

**Vaihe 4: fysiikka ja pelihuone** (vaatii T3)

29. Rapier laiskasti ladattuna, demo yhdellä fysiikkaobjektilla (T3).
30. Pelihuoneen kuori ja hissin pysähdys (W3).
31. Pingis (M1).
32. Pöytäjalkapallo (M2).
33. Biljardi (M3).
34. Liikkeen interpolointi (T4), jos pingis tai kilpa-ajot sitä vaativat.

**Vaihe 5: isot ja kokeelliset**

35. Rakennustila: katalogi ja asettelu (W2, osa 1); törmäykset ja kävelyruudukko (osa 2).
36. Kosketusohjaus tableteille (L2).
37. Näppäinten uudelleenmääritys (L5).
38. Vieraskäyttäjät, vaatii turvallisuuskatselmoinnin (S6).
39. WebXR-spike (L6), tulos dokumentiksi ennen jatkopäätöstä.

## 6. Fork-saumat

Säännöt [fork.md](../fork.md):stä ja [AGENTS.md](../../AGENTS.md):stä: fork-koodi uusiin tiedostoihin,
upstream-tiedostoihin vain pienet `3d-kanban`-kommentilla merkityt saumat, jokainen saumarivi
`docs/fork.md`:n taulukkoon. Upstream muuttuu eniten tiedostoissa `main.ts`, `server.ts`,
`protocol.ts` ja `workers.ts`, joten niihin kosketaan mahdollisimman vähän.

**Uudet fork-kansiot** (eivät ole saumoja, eivät voi konfliktoida): `src/client/fun/`,
`src/shared/fun/`, `src/server/fun/`, `tests/fun-*.test.ts`. Lisätään `AGENTS.md`:n fork-koodilistaan
ja `docs/fork.md`:n *New files are not seams* -kappaleeseen.

**Todennäköiset saumat** (yksi rivi kukin `docs/fork.md`:hen):

| Tiedosto | Missä | Mitä | Ideat |
|---|---|---|---|
| `src/server/server.ts` | WS-viestien switch, `installKanban`in vieressä | `isFunMsg(msg)` → `fun.handle(c, msg)`; `installFun({...})` | T1, T2 ja kaikki minipelit |
| `src/shared/protocol.ts` | `ClientMsg`/`ServerMsg`-unionit | Yksi rivi: `\| FunClientMsg` / `\| FunServerMsg` (tyypit `shared/fun/`issa) | T1 |
| `src/client/main.ts` | `net.onMessage`, render-loop, `interact()` | `fun.onMessage(msg)`, `fun.tick(dt)`, `fun.interact(target)`; `mountHud([...])`-rivit | Kaikki |
| `src/client/player.ts` | syöttö (näppäimet, `pointermove`) | `setInputSource()`-koukku, jonka kautta gamepad ja kosketustikku syöttävät liikettä | L1, L2, L5 |
| `src/client/world/office.ts` | huonekalut ja kolliderit | `extraProps(floor)`-koukku: työpisteen pientavarat, pelipöydät, rakennustilan kalusteet | W1, W2, W3, M4, M8 |
| `src/client/voice.ts` | `setVolume()` / audioelementti | Peer-virta `PannerNode`n kautta `sound.ts`:n `AudioContext`iin | S4 |
| `src/client/sound.ts` | `panner()` | Konvoluutiokaiku valittavissa huoneittain | A1 |
| `src/client/world/sky.ts` | kasvillisuuden värit | Vuodenaika-parametri | W4 |
| `src/client/world/elevator.ts`, `src/client/ui/elevator.ts` | pysähdykset | Pelihuoneen pysähdys | W3 |
| `src/client/ui/settings.ts` | `PANES` | Fork-paneelit (`...FUN_PANES`), kuten kanbanilla | S1, L5, T8 |
| `src/client/ui/emotes.ts`, `src/shared/emotes.ts` | `EMOTES` | Reaktiot (tai erillinen reaktiopyörä fork-tiedostossa, jos halutaan nolla saumaa) | S2, S8 |
| `src/client/laps.ts`, `golf.ts`, `throwing.ts`, `world/hoop.ts` | kohta, jossa ennätys tallennetaan | `fun.report(kind, value)` `localStorage`n lisäksi | M11, M12 |
| `package.json` *(unmarked)* | `dependencies` / `devDependencies` | `@dimforge/rapier3d-compat`, `three-mesh-bvh`, `troika-three-text`, `nipplejs` tarpeen mukaan | luku 3 |

Ennen isompaa minipeliä kannattaa katsoa, onko upstream ([AgentSystemLabs/agent-office](https://github.com/AgentSystemLabs/agent-office))
tehnyt saman tai jotain päällekkäistä: upstream lisää pelejä usein (golf, tikat ja kattobaari ovat sieltä),
ja oma rinnakkainen versio vaikeuttaisi synkronointia.

## 7. Avoimet kysymykset

- Pistetaulujen huijaussuoja: riittääkö uskottavuustarkistus, kun tulokset ovat tiimin sisäisiä? (Ehdotus: riittää.)
- Tallennetaanko tulokset koko rakennukselle (kuten BLOCKFALL) vai per kerros? (Ehdotus: koko rakennus, suodatus kerroksittain.)
- Saako rakennustilaa käyttää kuka tahansa vai vain admin? (Ehdotus: admin, kuten projektin poisto.)
- Kuinka paljon bundlen kokoa saa kasvaa? Rapier on selvästi suurin; ladataan vain pelihuoneessa.

## Lähteet

- npm-rekisteri, tarkistettu 2026-10-01: [`@dimforge/rapier3d-compat`](https://www.npmjs.com/package/@dimforge/rapier3d-compat),
  [`@dimforge/rapier3d-deterministic-compat`](https://www.npmjs.com/package/@dimforge/rapier3d-deterministic-compat),
  [`cannon-es`](https://www.npmjs.com/package/cannon-es), [`jolt-physics`](https://www.npmjs.com/package/jolt-physics),
  [`three-mesh-bvh`](https://www.npmjs.com/package/three-mesh-bvh), [`recast-navigation`](https://www.npmjs.com/package/recast-navigation),
  [`@recast-navigation/three`](https://www.npmjs.com/package/@recast-navigation/three), [`howler`](https://www.npmjs.com/package/howler),
  [`nipplejs`](https://www.npmjs.com/package/nipplejs), [`troika-three-text`](https://www.npmjs.com/package/troika-three-text),
  [`three.quarks`](https://www.npmjs.com/package/three.quarks), [`three-nebula`](https://www.npmjs.com/package/three-nebula),
  [`colyseus`](https://www.npmjs.com/package/colyseus), [`@msgpack/msgpack`](https://www.npmjs.com/package/@msgpack/msgpack),
  [`chess.js`](https://www.npmjs.com/package/chess.js), [`postprocessing`](https://www.npmjs.com/package/postprocessing),
  [`@react-three/xr`](https://www.npmjs.com/package/@react-three/xr).
- Rapier: [JavaScript character controller](https://rapier.rs/docs/user_guides/javascript/character_controller),
  [GitHub dimforge/rapier](https://github.com/dimforge/rapier).
- three.js: [XRButton](https://threejs.org/docs/pages/XRButton.html), [PositionalAudio](https://threejs.org/docs/#api/en/audio/PositionalAudio).
- MDN: [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API),
  [PannerNode](https://developer.mozilla.org/en-US/docs/Web/API/PannerNode),
  [ConvolverNode](https://developer.mozilla.org/en-US/docs/Web/API/ConvolverNode).
- Colyseus: [0.18-julkaisu](https://colyseus.io/blog/colyseus-018-is-here/), [dokumentaatio](https://docs.colyseus.io/).
- Assetit: [Kenney – lisenssi](https://kenney.nl/support), [KayKit Furniture Bits (GitHub, CC0)](https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0),
  [KayKit itch.io](https://kaylousberg.itch.io/furniture-bits), [Quaternius – lisenssi](https://quaternius.com/license.html),
  [Poly Pizza](https://poly.pizza/).
- Repon omat: [features.md](../features.md), [controls.md](../controls.md), [maps.md](../maps.md),
  [fork.md](../fork.md), [kanban-architecture.md](../kanban-architecture.md).
