// Generate test fixtures: an AcroForm PDF, a flat (field-less) PDF, and a source file.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync, mkdirSync } from "node:fs";

mkdirSync("fixtures", { recursive: true });

// --- 1. AcroForm PDF with real interactive fields ---------------------------
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  const draw = (text, y) =>
    page.drawText(text, { x: 50, y, size: 12, font, color: rgb(0, 0, 0) });

  page.drawText("Membership Application", { x: 50, y: 740, size: 18, font });

  draw("Full Name:", 690);
  const name = form.createTextField("full_name");
  name.addToPage(page, { x: 160, y: 684, width: 300, height: 20 });

  draw("Email:", 650);
  const email = form.createTextField("email");
  email.addToPage(page, { x: 160, y: 644, width: 300, height: 20 });

  draw("Phone:", 610);
  const phone = form.createTextField("phone");
  phone.addToPage(page, { x: 160, y: 604, width: 300, height: 20 });

  draw("Country:", 570);
  const country = form.createDropdown("country");
  country.addOptions(["Maldives", "India", "Sri Lanka", "United States"]);
  country.addToPage(page, { x: 160, y: 564, width: 200, height: 20 });

  draw("Subscribe to newsletter:", 530);
  const sub = form.createCheckBox("subscribe");
  sub.addToPage(page, { x: 220, y: 528, width: 16, height: 16 });

  const bytes = await doc.save();
  writeFileSync("fixtures/acroform.pdf", bytes);
  console.log("wrote fixtures/acroform.pdf");
}

// --- 2. Flat PDF: labels + blank lines, NO form fields ----------------------
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("Patient Intake Form", { x: 50, y: 740, size: 18, font: bold });

  const rows = [
    ["Full Name:", 690],
    ["Date of Birth:", 650],
    ["Email Address:", 610],
    ["Phone Number:", 570],
    ["Country:", 530],
  ];
  for (const [label, y] of rows) {
    page.drawText(label, { x: 50, y, size: 12, font });
    // underline blank for the answer
    page.drawLine({
      start: { x: 180, y: y - 3 },
      end: { x: 520, y: y - 3 },
      thickness: 1,
      color: rgb(0.4, 0.4, 0.4),
    });
  }

  const bytes = await doc.save();
  writeFileSync("fixtures/flat.pdf", bytes);
  console.log("wrote fixtures/flat.pdf");
}

// --- 3. Source info -------------------------------------------------------
writeFileSync(
  "fixtures/source.txt",
  `Personal details for Mohamed Vildhan.
Date of birth: 12 March 1995.
Email: vildhan@example.com
Mobile phone: +960 777-1234
Nationality / Country: Maldives
He would like to receive the newsletter.`,
);
console.log("wrote fixtures/source.txt");
