from __future__ import annotations

from pathlib import Path

import pytesseract
from PIL import Image


class OcrService:
    def extract_text_from_image(self, file_path: Path, lang: str = "eng") -> str:
        image = Image.open(file_path)
        return pytesseract.image_to_string(image, lang=lang)
