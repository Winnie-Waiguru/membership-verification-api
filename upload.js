import multer from "multer";
import path from "path";
import fs from "fs";

// Make sure upload folders exist
const uploadFolders = [
  "uploads/ids",
  "uploads/certificates",
  "uploads/passports",
];
uploadFolders.forEach((folder) => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "national_id_document") cb(null, "uploads/ids");
    else if (file.fieldname === "award_certificate_document")
      cb(null, "uploads/certificates");
    else if (file.fieldname === "passport_photo") cb(null, "uploads/passports");
    else cb(new Error("Unknown file field"), null);
  },
  filename: (req, file, cb) => {
    // Use full_name from req.body + doc type + timestamp
    const name = req.body.full_name || "user";
    const safeName = name.replace(/\s+/g, "_"); // replace spaces with _
    const ext = path.extname(file.originalname); // preserve extension
    const timestamp = Date.now();
    let docType = file.fieldname.replace(/_document|_photo/, "");
    cb(null, `${safeName}_${docType}_${timestamp}${ext}`);
  },
});

export const upload = multer({ storage });
