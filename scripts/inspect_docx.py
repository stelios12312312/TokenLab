import sys
import zipfile
import xml.etree.ElementTree as ET

def extract_docx_text(docx_path):
    # Namespace dictionary for DOCX XML tags
    namespaces = {
        'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    }
    
    try:
        with zipfile.ZipFile(docx_path) as docx:
            # The main document body is in word/document.xml
            xml_content = docx.read('word/document.xml')
            root = ET.fromstring(xml_content)
            
            paragraphs = []
            for para in root.findall('.//w:p', namespaces):
                text_parts = []
                for run in para.findall('.//w:r', namespaces):
                    for t in run.findall('.//w:t', namespaces):
                        if t.text:
                            text_parts.append(t.text)
                para_text = "".join(text_parts).strip()
                if para_text:
                    paragraphs.append(para_text)
            return paragraphs
    except Exception as e:
        print(f"Error reading {docx_path}: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 inspect_docx.py <path_to_docx>")
        sys.exit(1)
    
    path = sys.argv[1]
    paragraphs = extract_docx_text(path)
    for i, p in enumerate(paragraphs):
        print(f"{i+1}: {p}")
