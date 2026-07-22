import sys
from pypdf import PdfReader

def extract_text(pdf_path, txt_path):
    print(f"Reading {pdf_path}...")
    reader = PdfReader(pdf_path)
    print(f"Total pages: {len(reader.pages)}")
    text_content = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text()
        text_content.append(f"--- PAGE {i+1} ---\n{text}\n")
    
    with open(txt_path, "w", encoding="utf-8") as f:
        f.writelines(text_content)
    print(f"Extracted text successfully to {txt_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python extract_pdf_text.py <pdf_path> <txt_path>")
        sys.exit(1)
    extract_text(sys.argv[1], sys.argv[2])
