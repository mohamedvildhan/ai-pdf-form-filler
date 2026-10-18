# AI PDF Form Filler

Fill PDF forms from your documents with AI. Review overlays on the page, edit in English or Dhivehi, then download.

## Features

- Detect blanks on AcroForm and flat PDFs
- Fill from PDFs, images, Word docs, or pasted text
- Live overlay review (drag, type, add boxes)
- English ↔ Dhivehi (Thaana) fill language with translation
- Download a filled PDF

## Setup

```bash
npm install
```

Create `.env.local`:

```bash
GEMINI_API_KEY=your_key_here
```

Run:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Stack

Next.js, TypeScript, Tailwind CSS, pdf-lib, Gemini.
