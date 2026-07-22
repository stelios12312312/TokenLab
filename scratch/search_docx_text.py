import docx

doc = docx.Document("docs_final/Z1_TOKEN_LIFECYCLE_V2.docx")

print("Searching paragraphs...")
for idx, para in enumerate(doc.paragraphs):
    text = para.text.strip()
    if not text:
        continue
    # Search for keywords
    for keyword in ["viewer", "reserve", "inflow", "circulation", "recirculation"]:
        if keyword in text.lower():
            print(f"P{idx}: {text}")
            break
