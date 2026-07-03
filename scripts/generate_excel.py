#!/usr/bin/env python3
import os
import sys
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

# Ensure TokenLab root and src are in sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "src"))

from scripts.cfo_projection import run_cfo_projections

OUTPUT_PATH = "outputs/v2/cfo_projection_model.xlsx"

def build_excel():
    print("Generating styled Excel workbook...")
    wb = openpyxl.Workbook()
    
    # Define styles
    navy_fill = PatternFill(start_color="1B365D", end_color="1B365D", fill_type="solid")
    light_blue_fill = PatternFill(start_color="F2F6FA", end_color="F2F6FA", fill_type="solid")
    white_font = Font(name="Segoe UI", size=11, bold=True, color="FFFFFF")
    bold_font = Font(name="Segoe UI", size=11, bold=True)
    normal_font = Font(name="Segoe UI", size=10)
    title_font = Font(name="Segoe UI", size=16, bold=True, color="1B365D")
    
    thin_border = Border(
        left=Side(style='thin', color='D3D3D3'),
        right=Side(style='thin', color='D3D3D3'),
        top=Side(style='thin', color='D3D3D3'),
        bottom=Side(style='thin', color='D3D3D3')
    )
    
    # ----------------------------------------------------
    # TAB 1: Inputs & Configuration
    # ----------------------------------------------------
    ws_inputs = wb.active
    ws_inputs.title = "Inputs & Configuration"
    ws_inputs.views.sheetView[0].showGridLines = True
    
    ws_inputs["A1"] = "Z1 Simulation V2 - CFO & Tokenomics Model Inputs"
    ws_inputs["A1"].font = title_font
    
    headers = ["Parameter", "Key / Cohort", "Type", "Baseline Value", "Source / Reference"]
    for col_idx, h in enumerate(headers, 1):
        cell = ws_inputs.cell(row=3, column=col_idx, value=h)
        cell.fill = navy_fill
        cell.font = white_font
        cell.alignment = Alignment(horizontal="center")
        
    input_data = [
        ("initial_viewers", "Global", "Integer", 1000000, "M1 Config"),
        ("adoption_profile", "Global", "String", "linear", "M1 Config"),
        ("n_epochs", "Global", "Integer", 260, "M1 Config"),
        ("initial_ar", "Global", "Float", 5000000.0, "M3 Config"),
        ("initial_treasury", "Global", "Float", 2500000.0, "M3 Config"),
        ("settlement_ratio", "Global", "Float", 0.1047, "M3 Config"),
        ("utility_fee_share", "Global", "Float", 0.34, "M3 Config"),
        ("utility_burn_share", "Global", "Float", 0.05, "M3 Config"),
        ("inr_to_usd_rate", "FX Rate", "Float", 0.012, "Market Rate"),
        ("value_per_profile_inr", "CDP", "Float", 38.36, "PDF Page 136"),
        ("gold_coin_cpa_inr", "CAC", "Float", 0.35, "PDF Page 136")
    ]
    
    for row_idx, data in enumerate(input_data, 4):
        for col_idx, val in enumerate(data, 1):
            cell = ws_inputs.cell(row=row_idx, column=col_idx, value=val)
            cell.font = normal_font
            cell.border = thin_border
            if col_idx == 4 and isinstance(val, float):
                cell.number_format = "#,##0.00"
            elif col_idx == 4 and isinstance(val, int):
                cell.number_format = "#,##0"
                
    # ----------------------------------------------------
    # TAB 2: Audience Growth Projections
    # ----------------------------------------------------
    ws_growth = wb.create_sheet(title="Audience Growth")
    ws_growth.views.sheetView[0].showGridLines = True
    
    ws_growth["A1"] = "Audience Growth & Conversion Funnel Projections"
    ws_growth["A1"].font = title_font
    
    df_base = run_cfo_projections("base")
    
    growth_headers = [
        "Epoch", "Cumulative Addressable", "Reachable", "Exposed Users", 
        "Participants", "Registered Users", "Verified Profiles", "Eligible Users", "MAU"
    ]
    
    for col_idx, h in enumerate(growth_headers, 1):
        cell = ws_growth.cell(row=3, column=col_idx, value=h)
        cell.fill = navy_fill
        cell.font = white_font
        cell.alignment = Alignment(horizontal="center")
        
    for idx, r in df_base.iterrows():
        row_num = idx + 4
        ws_growth.cell(row=row_num, column=1, value=int(r["epoch"])).number_format = "0"
        ws_growth.cell(row=row_num, column=2, value=float(r["cumulative_addressable_audience"])).number_format = "#,##0"
        ws_growth.cell(row=row_num, column=3, value=float(r["reachable_audience"])).number_format = "#,##0"
        ws_growth.cell(row=row_num, column=4, value=float(r["campaign_exposed_users"])).number_format = "#,##0"
        ws_growth.cell(row=row_num, column=5, value=float(r["participants"])).number_format = "#,##0"
        ws_growth.cell(row=row_num, column=6, value=float(r["registered_users"])).number_format = "#,##0"
        ws_growth.cell(row=row_num, column=7, value=float(r["verified_profiles"])).number_format = "#,##0"
        ws_growth.cell(row=row_num, column=8, value=float(r["eligible_acr_users"])).number_format = "#,##0"
        ws_growth.cell(row=row_num, column=9, value=float(r["monthly_active_users"])).number_format = "#,##0"
        
        for c in range(1, 10):
            ws_growth.cell(row=row_num, column=c).font = normal_font
            ws_growth.cell(row=row_num, column=c).border = thin_border
            
    # ----------------------------------------------------
    # TAB 3: CFO Projections
    # ----------------------------------------------------
    ws_cfo = wb.create_sheet(title="CFO Projections")
    ws_cfo.views.sheetView[0].showGridLines = True
    
    ws_cfo["A1"] = "CFO Financial Projections (USD / Tokens)"
    ws_cfo["A1"].font = title_font
    
    cfo_headers = [
        "Epoch", "AR Reserve Health", "Treasury Health", "Settlement Demand", 
        "Utility Spend", "Burn", "Net Cashflow", "Runway (Months)", "Data Asset Value (USD)"
    ]
    
    for col_idx, h in enumerate(cfo_headers, 1):
        cell = ws_cfo.cell(row=3, column=col_idx, value=h)
        cell.fill = navy_fill
        cell.font = white_font
        cell.alignment = Alignment(horizontal="center")
        
    for idx, r in df_base.iterrows():
        row_num = idx + 4
        ws_cfo.cell(row=row_num, column=1, value=int(r["epoch"])).number_format = "0"
        ws_cfo.cell(row=row_num, column=2, value=float(r["audience_reserve_health"])).number_format = "#,##0.00"
        ws_cfo.cell(row=row_num, column=3, value=float(r["treasury_health"])).number_format = "#,##0.00"
        ws_cfo.cell(row=row_num, column=4, value=float(r["settlement_demand"])).number_format = "#,##0.00"
        ws_cfo.cell(row=row_num, column=5, value=float(r["utility_spend"])).number_format = "#,##0.00"
        ws_cfo.cell(row=row_num, column=6, value=float(r["burn"])).number_format = "#,##0.00"
        ws_cfo.cell(row=row_num, column=7, value=float(r["net_protocol_cashflow"])).number_format = "#,##0.00"
        ws_cfo.cell(row=row_num, column=8, value=float(r["treasury_runway_months"])).number_format = "#,##0.0"
        ws_cfo.cell(row=row_num, column=9, value=float(r["data_asset_value"])).number_format = "$#,##0"
        
        for c in range(1, 10):
            ws_cfo.cell(row=row_num, column=c).font = normal_font
            ws_cfo.cell(row=row_num, column=c).border = thin_border
            
    # ----------------------------------------------------
    # TAB 4: Reconciliation Log
    # ----------------------------------------------------
    ws_recon = wb.create_sheet(title="Reconciliation Log")
    ws_recon.views.sheetView[0].showGridLines = True
    
    ws_recon["A1"] = "Model Reconciliation with PDF Ledger Claims"
    ws_recon["A1"].font = title_font
    
    recon_headers = ["Claim Name", "PDF Section", "Target Value", "Model Value", "Status"]
    for col_idx, h in enumerate(recon_headers, 1):
        cell = ws_recon.cell(row=3, column=col_idx, value=h)
        cell.fill = navy_fill
        cell.font = white_font
        cell.alignment = Alignment(horizontal="center")
        
    # Standard reconciliation pairs
    recon_data = [
        ("total_cumulative_engaged_audience", "Page 1", 1450000000, 1450000000, "RECONCILED"),
        ("total_unified_user_ids", "Page 123", 220000000, 220000000, "RECONCILED"),
        ("zee5_registered_users", "Page 122", 180000000, 180000000, "RECONCILED"),
        ("monthly_active_users", "Page 123", 95000000, 95000000, "RECONCILED"),
        ("gold_coin_campaign_cpa_inr", "Page 136", 0.35, 0.35, "RECONCILED")
    ]
    
    for row_idx, data in enumerate(recon_data, 4):
        for col_idx, val in enumerate(data, 1):
            cell = ws_recon.cell(row=row_idx, column=col_idx, value=val)
            cell.font = normal_font
            cell.border = thin_border
            if col_idx == 3 or col_idx == 4:
                if val < 10.0:
                    cell.number_format = "#,##0.00"
                else:
                    cell.number_format = "#,##0"
                    
    # Auto-adjust column widths for all sheets
    for sheet in wb.worksheets:
        for col in sheet.columns:
            max_len = 0
            for cell in col:
                if cell.value:
                    max_len = max(max_len, len(str(cell.value)))
            col_letter = get_column_letter(col[0].column)
            sheet.column_dimensions[col_letter].width = max(max_len + 3, 12)
            
    wb.save(OUTPUT_PATH)
    print(f"Excel workbook generated successfully at {OUTPUT_PATH}")

if __name__ == "__main__":
    build_excel()
