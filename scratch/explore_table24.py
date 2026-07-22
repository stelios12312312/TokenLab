import docx
import sys

def explore(path):
    doc = docx.Document(path)
    table = doc.tables[24]
    for idx, row in enumerate(table.rows):
        vals = [cell.text.strip().replace('\n', ' ') for cell in row.cells]
        print(f"Row {idx}: {vals}")

if __name__ == "__main__":
    explore(sys.argv[1] if len(sys.argv) > 1 else "docs_final/Z1_TOKEN_LIFECYCLE_V2.docx")
