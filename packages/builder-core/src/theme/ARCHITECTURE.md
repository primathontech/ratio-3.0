# How the theme system works

A **theme** is the _look_ of a shop — its home page, header, footer, product page, colours and fonts.

We have four themes today. **Each one is a full, complete theme on its own.**

```mermaid
flowchart LR
  forma[Forma]
  nova[Nova]
  aura[Aura]
  atelier[Atelier]
```

---

## What do themes share? Only the data and the page rules — not the look

Themes do **not** share their look. Every theme can look totally different.
They share just two things:

1. **The data** — products and collections (same for every theme).
2. **The page rules** — where the header, footer and content go (same slots for every theme).

```mermaid
flowchart TD
  shared["SHARED (same for all)<br/>• product / collection data<br/>• page slots (header, footer, content)"]
  shared --> forma["Forma<br/>(its own look)"]
  shared --> nova["Nova<br/>(its own look)"]
  shared --> aura["Aura<br/>(its own look)"]
  shared --> atelier["Atelier<br/>(its own look)"]
```

So: **same data, different look.** A theme can have a different home, header, footer, collection page and
product page — only the data behind them is the same.

---

## The one thing that confuses people: two kinds of "mixing"

The word "mix / combine" is used in **two totally different places**. Please keep them apart.

```mermaid
flowchart LR
  subgraph K1["Kind 1 — when we BUILD a theme (once, by a developer)"]
    direction LR
    a["theme folder"] --> b["one full theme<br/>saved in the library"]
  end
  subgraph K2["Kind 2 — when a SHOP uses a theme (on every page view)"]
    direction LR
    c["theme from library"] --> e["full page"]
    d["shop's small changes"] --> e
  end
```

|            | Kind 1 — build time                    | Kind 2 — shop time               |
| ---------- | -------------------------------------- | -------------------------------- |
| When       | once, when a developer makes the theme | every time someone opens a shop  |
| What joins | files in the theme folder → one theme  | the theme + the shop's own edits |
| Result     | one full theme in the library          | the full page shown to the buyer |

---

## Kind 1 — how a theme is built and saved

Each theme is just a **folder of files** (home page, header, footer, product page, style, and so on).
A small script (`npm run gen:themes`) turns that folder into code. The theme is then saved **once** in
the library as "version 1".

```mermaid
flowchart LR
  dir["nova/ folder<br/>(all its files)"] -->|npm run gen:themes| gen["nova-theme.generated.ts<br/>(same files, as code)"]
  gen --> fn["novaBundleTheme()<br/>returns its own files"]
  fn --> reg["theme list (base-library.ts)"]
  reg -->|seed once| lib[("Library<br/>Nova = version 1<br/>Aura = version 1<br/>…")]
```

Two important points:

- **Saved once, then frozen.** After a theme is saved in the library, it does **not** change by itself.
- **Each saved theme is complete.** Nova in the library has _all_ its own files. It does not borrow
  anything from Forma to work.

> Long ago Nova/Aura/Atelier borrowed some files from Forma to save typing. **Not any more** — today
> every theme is its own full folder. (Borrowing is still allowed for a tiny "just a new home page"
> theme, but no theme does that now.)

---

## Kind 2 — how a shop uses a theme

A shop **picks one theme**. The shop can change a few files (its own header text, its brand colour).
The shop saves **only what it changed** — nothing else. When a buyer opens the shop, we join the theme
and the shop's changes to make the full page.

```mermaid
flowchart LR
  pick["shop picks Nova"] --> tag["shop remembers:<br/>theme = Nova, version = 1"]
  tag --> join
  edits["shop changed 2 files<br/>(saved as changes only)"] --> join["join: theme + shop changes"]
  join --> page["full page"]
```

- The shop saves **only its edits**. Every file it did _not_ touch simply comes from the theme.
- So nothing is ever missing — untouched files fall back to the theme.
- This is also why a shop can later get an **improved theme** without losing its own edits (next section).

### Showing a page to a buyer

```mermaid
sequenceDiagram
  participant Buyer
  participant Edge as Edge (just forwards)
  participant Origin as Origin (builds the page)
  participant Store as Storage
  Buyer->>Edge: open the shop
  Edge->>Origin: forward the request
  Origin->>Store: get the shop's theme + version
  Origin->>Store: get the shop's own changes
  Origin->>Origin: join them → build the page
  Origin-->>Buyer: full HTML page
```

### Improving a theme later (and pushing it to shops)

If we make a theme better, we save it as a **new version**. Shops using that theme can pull the new
version in. Each shop keeps its own edits (only the files it did not change get updated).

```mermaid
flowchart LR
  edit["improve Nova → save version 2"] --> find["find shops on Nova, still on version 1"]
  find --> push["update them to version 2<br/>(their own edits stay)"]
  push --> fresh["new page shown"]
```

This only touches shops on **that** theme. Improving Nova never touches Aura, Atelier or Forma shops.

---

## The data every theme gets (the "same data")

Every theme reads the **same, simple data**. The look around it is the theme's own choice.

| The theme asks for   | It gets                              | Each item has                                                                  |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| products / a listing | a list of products                   | `title`, `price` (in paise), `image`, `handle`, old price (if any), short text |
| a collection         | a list of that collection's products | same product fields                                                            |
| one product          | one product                          | `title`, `price`, images, description, variant                                 |
| collections          | a list of collections                | `title`, `handle`                                                              |

Price is always in **paise**. Show it with the `money` filter to get `₹499.00`.
Only three filters are allowed in theme code: `money`, `escape`, `default`.

---

## What every theme must have

A theme is free in its **look**, but it must include these files so the system can render it:

```mermaid
flowchart TD
  theme["a theme folder must have"] --> layout["layout/theme.liquid<br/>(the full page shell + slots)"]
  theme --> chrome["sections/header.liquid<br/>sections/footer.liquid<br/>sections/order.liquid"]
  theme --> tpl["templates/index.json<br/>templates/collection.json<br/>templates/product.json<br/>(+ the sections they use)"]
  theme --> styles["config/tokens.json<br/>assets/base.css"]
```

The page shell (`layout/theme.liquid`) must leave **slots** the system fills in: the page content
(`content_for_layout`), the header and footer, the styles, and a couple of system slots
(`content_for_header`, `content_for_body_end`).

---

## "Are the themes really separate?" — yes

- **When a buyer opens a shop:** fully separate. Each theme is complete and stands on its own. A Nova
  shop never looks at Forma.
- **The only shared thing** is the data and the page slots above — never the look.
- **Nothing is ever missing.** Each theme carries all its own files.

Want the step-by-step to make a new theme? See [`library/README.md`](./library/README.md).
