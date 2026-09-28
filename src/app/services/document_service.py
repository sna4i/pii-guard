from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader


class DocumentService:
    def extract_text_from_pdf(self, file_path: Path) -> tuple[str, dict]:
        reader = PdfReader(str(file_path))
        texts: list[str] = []
        page_meta: list[dict] = []

        for idx, page in enumerate(reader.pages):
            content = page.extract_text() or ""
            texts.append(content)
            page_meta.append({"page": idx + 1, "text_length": len(content)})

        merged = "\n".join(texts)
        return merged, {"pages": len(reader.pages), "page_meta": page_meta}

    def needs_ocr(self, extracted_text: str) -> bool:
        return len(extracted_text.strip()) < 20

    def redact_file_placeholder(self, file_path: Path) -> Path:
        return file_path
