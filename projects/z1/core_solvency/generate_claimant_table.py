import os
import pandas as pd

def generate_claimant_table():
    populations = [
        45_000_000,
        95_000_000,
        180_000_000,
        220_000_000,
        400_000_000,
        1_050_000_000,
        1_450_000_000
    ]
    
    claim_rates = [0.20, 0.50, 0.5278, 0.67, 0.80]
    verification_pass_rate = 0.94
    
    records = []
    
    for pop in populations:
        row = {'Population': f"{pop:,}"}
        for cr in claim_rates:
            vc = pop * cr * verification_pass_rate
            
            # Format to millions for readability in MD, but keep full number in CSV?
            # Let's keep it as millions with 2 decimals
            vc_m = vc / 1_000_000
            col_name = f"CR {cr*100:.2f}%"
            row[col_name] = f"{vc_m:.2f}M"
        records.append(row)
        
    df = pd.DataFrame(records)
    
    os.makedirs(os.path.join("outputs"), exist_ok=True)
    
    csv_path = os.path.join("outputs", "z1_m1_verified_claimants_table.csv")
    md_path = os.path.join("outputs", "z1_m1_verified_claimants_table.md")
    
    df.to_csv(csv_path, index=False)
    
    with open(md_path, "w") as f:
        f.write("# Z1 M1 Verified Claimants Reference Table\n\n")
        f.write("Formula: `verified_claimants = population * claim_rate * verification_pass_rate (0.94)`\n\n")
        f.write(df.to_markdown(index=False))
        
    print(f"Saved {csv_path}")
    print(f"Saved {md_path}")

if __name__ == "__main__":
    generate_claimant_table()
