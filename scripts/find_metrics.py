import re

def search_patterns():
    with open("scratch/zee_ledger_text.txt", "r", encoding="utf-8") as f:
        content = f.read()
    
    pages = content.split("--- PAGE ")
    
    targets = {
        "1.45B / 1450M / 1,450,000,000": [r"1\s*[.,]\s*45", r"1450", r"1,450,000,000"],
        "220M / 220,000,000": [r"220\s*million", r"220,000,000", r"220\s*M"],
        "180M / 180,000,000": [r"180\s*million", r"180,000,000", r"180\s*M"],
        "95M / 95,000,000 / monthly active / viewing history": [r"95\s*million", r"95,000,000", r"95\s*M", r"monthly\s*active", r"viewing\s*history"],
        "45M / 45,000,000": [r"45\s*million", r"45,000,000", r"45\s*M"],
        "35M / 35,000,000": [r"35\s*million", r"35,000,000", r"35\s*M"],
        "gold coin / 0.35 / CPA": [r"gold\s*coin", r"0\s*[.,]\s*35", r"CPA"],
        "QR Code / 45 / 80": [r"QR\s*Code", r"45", r"80"],
        "WhatsApp / 60 / 100": [r"WhatsApp", r"60", r"100"],
        "OBD / 11": [r"OBD", r"11"],
        "Voice Assistant / 80 / 120": [r"Voice\s*Assistant", r"120"],
        "ZEE5 Registration Wall / 180 / 240": [r"Registration\s*Wall", r"180", r"240"],
        "581,684 / unique users": [r"581\s*[,.]\s*684", r"581684"]
    }
    
    for name, patterns in targets.items():
        print(f"\n==================================================")
        print(f"SEARCHING FOR: {name}")
        print(f"==================================================")
        matches_found = 0
        for page_data in pages:
            if not page_data.strip():
                continue
            lines = page_data.split("\n")
            page_num = lines[0].split(" ---")[0]
            page_text = "\n".join(lines[1:])
            
            for pattern in patterns:
                matches = list(re.finditer(pattern, page_text, re.IGNORECASE))
                if matches:
                    for match in matches:
                        start = max(0, match.start() - 150)
                        end = min(len(page_text), match.end() + 150)
                        snippet = page_text[start:end].replace("\n", " ")
                        print(f"Page {page_num} match for '{pattern}': ... {snippet} ...")
                        matches_found += 1
                        if matches_found >= 5:
                            break
                if matches_found >= 5:
                    break

if __name__ == "__main__":
    search_patterns()
