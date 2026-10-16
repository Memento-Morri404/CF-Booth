# Card Fair Booth

Your trade show register and public storefront, running on your own computer.

- **`/booth`** is your register: inventory, haggle meter, deal bins, cash and change, trades and sales. It is behind a password.
- **`/`** is the storefront your QR code opens. It shows only what is in stock, with name, set, condition, price and picture. It never shows costs, market prices, haggle lines, notes, locations or sales. The server strips those out as well, so nothing private can be published by mistake.

The only thing to install is Node. Cloudflare's `cloudflared` is optional and only needed to share the storefront publicly.

```
card-fair-booth/
  start-mac.command    double-click to start (macOS)
  start-windows.bat    double-click to start (Windows)
  server.js            the server (no dependencies)
  tcg.js               card details and market prices (TCGdex)
  tcgplayer.js         TCGplayer's daily prices and pictures (via TCGCSV), the backup source
  pricecharting.js     optional graded prices (PriceCharting, needs your token)
  justtcg.js           optional prices by condition (JustTCG, free key)
  .env.example         your settings; the start script makes .env for you
  public/              booth.html (register), index.html (storefront), offline files, icons
  data/                created on first run: records, backups, card cache
```

---

## 1. Start it

1. Install Node 18 or newer from https://nodejs.org (the LTS button).
2. Double-click **start-mac.command** (macOS) or **start-windows.bat** (Windows).
   - The first time, it asks you to pick a booth password and saves it in `.env`.
   - On macOS, if it says the file can't be opened, right-click it, choose **Open**, then confirm.
3. Open http://localhost:8080/booth and sign in.

The window also prints an address like `http://192.168.1.20:8080/booth`. A tablet on the same Wi-Fi can open that to use the register too, and both devices stay in sync.

To stop it, close the window or press Ctrl+C. Your data stays in the `data` folder.

Prefer a terminal? `BOOTH_PASSWORD=your-password node server.js` works too.

## 2. Add your cards without typing every field

The card data and market prices come from **TCGdex**, a free card database. Your computer looks them up and caches them, so a card you've looked up once opens instantly afterward, even offline.

**Add cards** (Inventory, top right) is the fast way to enter a stack:

1. The line at the top shows what every new card gets: language, condition, pricing, binder. Tap **Change** to set them.
2. Type a name, for example `umbreon`, and the most valuable printings come first. Narrow it with a number (`charizard 199`, `umbreon 161/131`), a set code (`umbreon evs`), `tg` or `gg` for the galleries, or a nickname (`moonbreon`, `sunbreon`).
   **One set at a time:** pick a set in the box left of the search (type a few letters of its name). With nothing typed, the whole set lists in number order, like a binder page. Type a name or number to search inside it. After each add, the next card in the set is picked.
3. Pick the card with ↑ ↓ and the printing with ← →. Special printings the card database knows about have their own price: Poké Ball and Master Ball patterns, cosmos, set-logo and staff stamps, and so on. Choosing one in the Pattern or Stamp menu picks that printing too.
4. Under the highlighted card, set anything special for **this copy** before adding it:
   - **Condition**: each button shows that condition's price.
   - **Stamp**: prerelease, staff, league, Pokémon Center and so on.
   - **Pattern**: Poké Ball, Master Ball and other reverse patterns.
   - **Slab**: grader and grade. With PriceCharting set up, the grade's price fills in.
   - **Price**: type your own, or leave it blank to price at your %.
5. Set the quantity, then press **Enter**. These options reset to your defaults after each card.

The set, number, rarity, series, mechanic, year, finish, picture and market price all fill in. Adding the same card with the same finish, condition, stamp and binder adds to that stack. The log at the bottom has **Edit** (opens that card, then brings you back) and **Undo**.

**Already imported your price tracker export?** Press **Update prices & details**. It matches every card by set and number (or its id from the tracker), fills in anything missing and refreshes market prices. For 1,200 cards, expect a few minutes the first time and much less after that. Cards it can't match get the **Needs review** tag; open each one and use the lookup at the top of the card editor.

Good to know:
- Graded cards keep the price you set. Raw-card market prices don't apply to slabs.
- **Languages:** English, Japanese and Simplified Chinese sit next to the search box. **More…** lists Traditional Chinese, Korean, Thai, Indonesian and the European languages. If a card isn't in the database yet (coverage of Asian sets varies), press **Add it by hand**. The name, number and language carry over.
- Cards in languages other than English fill in their details, but usually have no US market price. Check eBay and set one yourself.
- **Check live:** every card shows **TCGplayer** and **eBay sold** buttons (plus **PriceCharting** for graded cards). They're in Add cards, in the card editor, and in the register when you open a card to haggle. Each one opens a new tab with that card already searched. If a price looks wrong, type the right one into Market. **Update prices & details** keeps prices you entered by hand unless you untick that option.
- Prices refresh at most every 6 hours per card. Press **Update prices & details** the morning of a show.
- **Condition prices:** with JustTCG set up (below), LP, MP, HP and DMG use TCGplayer's real prices for that condition. Without it, they're priced from NM using the condition ladder in **Setup**. Condition buttons in Add cards, the card editor and trade-ins all show the price at each condition.

## 3. Deal cards

Any item can be priced by a **deal bin** instead of its own price. It then rings up with the bin's deal (3 for $1 and so on), even when mixed with bin taps on the register.

- **When adding:** in **Add cards**, choose a deal bin under pricing, or use the *Under $X market goes in…* rule.
- **One card:** in the card editor, under Price, choose **Deal bin** and pick the bin.
- **Many cards:** **Set prices** has *Put in a deal bin* (for example, every card under $1.50 market) and *Take out of deal bins*.
- The **In deal bins** filter shows them all. The haggle meter doesn't apply to deal cards.

## Cheap cards: no prices under $1

- No single card is priced under $1. A card that would price under $1 goes into your deal bins on its own:
  - 3 for $1 when that's within your firm % of its price (about 30¢ and under).
  - 2 for $1 up to about 55¢.
  - Above that, $1.
- When the market rises past $1, the card leaves the bin and gets its own price again. Cards you put in a bin yourself stay in that bin.
- Cards already priced under $1 (from an import, say) are fixed on the next launch. Typing a price under $1 in the editor puts the card in the matching bin.
- To change the $1 floor, go to **Setup → Pricing → Lowest single**.

## Stickers, accessories and art: variants and photos

Add one with **Add item** and pick **Accessory**, **Art & handmade** or **Other**.

- **Photos:** press **Add** under Photos to upload from your computer or phone. They're shrunk and saved on your computer (`data/photos`), and shown on the register and storefront.
- **Variations (like Square):** every variation is one row with its own name, SKU, price, stock and photo. The header shows how many variations and how many are in stock.
  - One-offs: **+ Add variation** and type a name (Black, Blue…).
  - Combinations: **Build from options**. Name the option (Size), type a value and press Enter (Standard, XL). Each combination becomes a row. Remove a combination you don't carry with ×; it stays removed when you add more values.
  - **Same price for all** copies the first price down.
- Each variation sells and counts stock on its own. Open any one to edit the whole product. Removing a value or row removes that variation and its stock.
- **Storefront:** stickers, accessories and art appear in a quiet side panel, *Also at the table*, with a photo, the price (or "From $4") and the variants, sold-out ones struck through. On phones it's a strip under the deal bins.

## Bundle offers

When someone says "these three for $1,100": add them to the sale, then press **Bundle offer** under the items.

- Tick what the offer covers. Cards, keychains, stickers and deal-bin cards can all be in it.
- Type their offer. The big tile shows the bundle's % of market and whether it's an easy yes, fine, a stretch, or under your lowest.
- Each line shows what that item would sell at and its own %, so you can see which card is dragging it down.
- **Counter** buttons fill in your lowest, 90% or 95%.
- **Take** spreads the total across the items. Every card stays at or above its own lowest when it can. Deal-bin cards keep their deal price, and keychains and stickers keep theirs unless the offer is under your lowest.
- Under your lowest: it turns red and needs a second tap.

## Trade-ins

On the register, press **Trade-in**, then type the card's name and number, like `gardevoir 245`. Pick the card and its finish. The set, number and market price fill in, and the credit is calculated at your trade-in % of market, rounded down. Set that % in **Setup → Pricing** (75% to start), or change it for one trade on the spot.

- Change the condition and the market and credit follow it, using your condition ladder.
- Type a different market or credit any time and your number sticks.
- When the sale is done, the card goes into inventory with its details, picture and market price, priced at your default %, with the credit as its cost.
- Slabs: raw market prices don't apply to graded cards. With PriceCharting set up (below), typing a grade like `PSA 10` or `BGS 9.5` pulls that grade's price. Without it, use **Check live** and type the market.


**Sealed:** switch the trade-in to **Sealed** and type the product, like `prismatic etb`, `surging sparks bb`, `151 bundle` or `pc etb`. Pick it and the TCGplayer market price fills in. Sealed has its own trade-in %.

**Your range:** set a low and high % for cards and for sealed in **Setup → Pricing** (cards 65–75%, sealed 70–80% to start). The trade window shows the credit at the low, middle and high of your range. Credit starts at the top; tap a step to use it.

**Is it a good trade?** With cards in the sale, the trade window shows what you give (at market) against what you get (the trade-ins at market, plus or minus cash), for example *+$24: you give $95 at market, get $120 in trade*. The sale total shows the same as **Trade vs market**.

## PriceCharting (optional, paid)

The free card data already covers market prices for raw English cards. PriceCharting adds:
- **Graded prices:** ungraded, 7, 8, 9, 9.5 and 10.
- **Japanese prices.** Type the English name on the trade-in; PriceCharting lists cards in English.

To turn it on, subscribe at pricecharting.com and copy your API token from the Subscription page (**API/Download**). Add `PRICECHARTING_TOKEN=your-token` to `.env` and restart. Trade-ins then price slabs automatically, and the card editor gets a **Set market from PriceCharting** button. Results are saved for 12 hours, so repeat lookups don't call PriceCharting again.

## Real prices by condition: JustTCG (optional, free tier)

TCGplayer's daily price list has one market price per card, which is about NM. JustTCG tracks TCGplayer by condition. With a JustTCG key, LP, MP, HP and DMG come from real prices instead of your ladder.

To turn it on, create a free account at justtcg.com, copy your API key, add `JUSTTCG_API_KEY=your-key` to `.env` and restart. Cards are looked up one at a time when you pick them in Add cards or a trade-in, or when you press **Get real prices** in the card editor. Results are saved for 12 hours, so the free tier goes a long way.

## Binders & cases

Go to **Inventory → Binders & cases** to set up where your cards live at the table.

- **Add a binder or case**: name it whatever you like, set how many cards it holds (360, 100, no limit), and choose what shoppers see:
  - **Where it is**: it's out on the table.
  - **Where it is, plus "ask me"**: for binders that stay behind the table, like Case Overflow. Shoppers still find the card and know to ask for it.
  - **Nothing**: hidden from the storefront.
- **Price rules, for your case**: give Case 1 and Case 2 a limit of 100 and "cards priced at $15 and up go here", and set **When it's full, extra cards go to → Case Overflow**.
- **Add cards** and trade-ins have a **Goes in** picker: a binder, or **By price**, which puts $15+ cards in a case with room, then overflow, and everything else in the binder you choose. Your last choice is remembered. Each binder on the board also has **Add cards here**.
- **Full cases spill over**: when you add a card to a case that's full and has an overflow set, it goes to the overflow instead, whether you picked the case directly or use **By price**. If a case ends up over its limit anyway, the board shows **Move N**: the cheapest extras go to its overflow, so the best cards stay on show.
- **Limits**: binders without an overflow show a warning when they're over, but nothing is blocked.
- **Restock**: when a case has open spots and its overflow has cards for it, the board shows **Restock**. It lists which cards to pull, highest price first, and moves them when you press **I moved them**. Selling a case card also reminds you.
- **Cards with no binder** (after an import, say) get a **Place them** button: by your price rules, the rest into one binder.
- Click a binder to see its cards. Edit one with the pencil. Renaming a binder renames it on every card.

On the storefront, cards are grouped by binder, and each card shows where it is. Ask-me binders come last, marked "Ask me".

## Pictures and prices for every card

Cards get their details, picture and market price from the card data by themselves. Pictures are added in the background to any card missing one, including imported cards. The same goes for a market price.

Two sources work together:
- **TCGdex**, the card database: details, pictures, and TCGplayer prices for most sets.
- **TCGplayer's daily price list** via TCGCSV (tcgcsv.com): your computer downloads it once a day. This fills the gaps, including Trainer Gallery, Galarian Gallery, Shiny Vault, promos, brand-new sets, and Japanese cards searched by their English name (`pikachu 132` with Japanese selected). The first download takes a few minutes in the background. It's saved in `data/cache/tcgcsv`, so it works offline. To turn it off, set `TCGPLAYER_PRICES=off`.

## 4. Share the storefront with Cloudflare Tunnel (free)

A tunnel gives your computer a public address like `https://cards.yourdomain.com` without opening your router. Shoppers on cellular data can then open the QR code. The register stays behind your password.

What it needs:
- Your domain using **Cloudflare's nameservers**. You keep the domain registered at GoDaddy; you only change where its DNS is handled. If the domain also runs a website or email, Cloudflare copies those records during setup. Check that they're all there before switching.
- Your computer **on, awake and online** while people should be able to browse. Turn off sleep on show days.

One-time setup:
1. Create a free account at https://dash.cloudflare.com, choose **Add a domain**, pick the Free plan and follow the steps. Then, in GoDaddy, go to **Domain → DNS → Nameservers → Change** and enter the two nameservers Cloudflare shows you. It can take a few hours to switch over.
2. Install `cloudflared`:
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Or download it from Cloudflare's "Downloads" page for cloudflared.
3. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels → Create a tunnel**, choose **Cloudflared** and name it `card-fair`.
4. Copy the **token**: the long string after `--token` in the install command it shows. You don't need to run that command.
5. On the **Public hostname** step, set the subdomain to `cards`, the domain to yours, the service type to `HTTP` and the URL to `localhost:8080`.
6. Open `.env` in this folder and add the line `CLOUDFLARE_TUNNEL_TOKEN=` followed by your token. Restart the booth.

From now on, starting the booth starts the tunnel too, and restarts it if the connection drops. The window prints *Cloudflare Tunnel connected*.

Then, in the booth, go to **Setup → Storefront**:
1. Set **Shopper link** to `https://cards.yourdomain.com/`.
2. Turn on **Keep the storefront updated while I sell**. Sold-out items drop off a few seconds after each sale.
3. Press **Save QR sign for the table** and print it.

Notes:
- Cloudflare's "quick tunnel" (`cloudflared tunnel --url …`) gives a random address that changes every time, so it won't work for a printed QR code.
- You can also sign in to `/booth` through the tunnel from any phone. It uses your password and locks out repeated wrong guesses.

## 5. Put it online full-time (no computer needed)

**Always online with Railway (about $5 a month).** The booth runs in the cloud, so the QR code works even when your computer is off. You use it at `https://your-name.up.railway.app/booth` from your laptop, tablet or phone.

1. **Put this folder on GitHub.** Make a free account at github.com, then create a new **private** repository named `card-fair-booth`. On its page, choose **uploading an existing file** and drag in everything in this folder *except* `data` and `.env`. Then choose **Commit changes**.
2. **Create the app.** Sign up at railway.com and pick the Hobby plan. Choose **New Project → Deploy from GitHub repo → card-fair-booth**. It finds `package.json` and starts `node server.js` without any extra setup.
3. **Add storage.** Without storage, every restart wipes your inventory. Right-click the empty canvas, choose **Volume**, attach it to the service and set the mount path to `/data`.
4. **Settings.** In the service's **Variables** tab, add:
   - `BOOTH_PASSWORD`: your password, at least 6 characters. Longer is safer, since this one is on the internet.
   - `DATA_DIR`: `/data`
   - Optional: `PRICECHARTING_TOKEN` and `JUSTTCG_API_KEY`, the same as in your `.env`.

   Railway restarts the app.
5. **Get your address.** Open **Settings → Networking → Generate Domain**. To use your own domain, choose **Custom Domain** instead and follow the DNS steps it shows.
6. **Move your inventory.**
   - On your computer's booth, go to **Setup → Back up everything**. Your uploaded photos are included.
   - Open the online booth, sign in, go to **Setup → Restore a backup**, and pick that file.
7. **QR code.** Go to **Setup → Storefront**. The shopper link is now your online address. Reprint the QR code.

From then on, use only the online booth, and stop the one on your computer, so you don't have two inventories. It still works without signal at the show: sales save on the device and sync when you're back online. Card prices download on the server by themselves.

**To update later:** on GitHub, upload the new files over the old ones and commit. Railway redeploys in about a minute, and your data on `/data` stays.

**Other hosts** (Render, Fly.io, a VPS) work the same way: start command `node server.js`, the same variables, and a persistent disk mounted at `DATA_DIR`.

**No server:** open `public/booth.html` directly. Data is saved in that browser only, and card lookup isn't available. To share, upload `public/index.html` plus the `storefront.json` from **Setup → Storefront → Export** to any static host.

---

## At the show

- **No signal?** The booth keeps working. Sales save on the device and sync when you're back online. Open the booth once beforehand so it can load offline.
- **Tablet as an app:** open `/booth` in Safari or Chrome and choose **Add to Home Screen**.
- **Two devices:** sign in on both. Stock is kept as a running history of changes, so two devices selling at once add up correctly.

## Your data

- Records live in `data/booth.json`, with a copy saved each day to `data/backups/`.
- Card details and prices are cached in `data/cache/`. It's safe to delete; it fills back up.
- **Setup → Your data → Back up everything** downloads a full backup, and importing that file restores it.
- To move computers, copy the `data` folder and `.env`.

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `BOOTH_PASSWORD` | required | Password for `/booth` (6+ characters). Changing it signs out every device. |
| `PORT` | `8080` | Port to listen on. If you change it, update the tunnel's URL too. |
| `CLOUDFLARE_TUNNEL_TOKEN` | off | Starts your Cloudflare Tunnel with the booth |
| `PRICECHARTING_TOKEN` | off | Optional, paid. Graded and Japanese prices from PriceCharting |
| `JUSTTCG_API_KEY` | off | Optional, free tier. Real NM/LP/MP/HP/DMG prices from JustTCG |
| `TCGPLAYER_PRICES` | on | Set to `off` to skip the daily TCGplayer price download |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to allow only this computer, with no tablets on Wi-Fi |
| `DATA_DIR` | `./data` | Where records, backups and the card cache are stored |
| `SECURE_COOKIE` | auto | Turned on automatically through the tunnel. Set to `1` behind another https proxy. |

Card data and images: TCGdex (tcgdex.dev). Market prices come from TCGplayer via TCGdex and can lag a day behind.
