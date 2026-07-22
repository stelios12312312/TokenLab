# tests/test_excel_model.py
# @planner:module = test_excel_model
# @planner:story = US-Z1-M3-05

import pytest
import os
import openpyxl

def test_excel_projection_sheets():
    excel_path = "outputs/v2_2026-07-06_120557/cfo_projection_model.xlsx"
    assert os.path.exists(excel_path), f"Excel projection model missing from {excel_path}."
    
    wb = openpyxl.load_workbook(excel_path)
    
    # 1. Assert sheet names exist
    expected_sheets = ["Inputs & Configuration", "Audience Growth", "CFO Projections", "Reconciliation Log"]
    for name in expected_sheets:
        assert name in wb.sheetnames, f"Sheet {name} missing from workbook."
        
    # 2. Check gridlines are enabled
    for name in expected_sheets:
        ws = wb[name]
        assert ws.views.sheetView[0].showGridLines is True, f"Gridlines disabled in sheet {name}."
        
    # 3. Check some cells in CFO Projections tab for formulas
    ws_cfo = wb["CFO Projections"]
    # Check header
    assert ws_cfo["E4"].value == "Audience Reserve (USD)"
    
    # Cell E5 should contain the conversion formula (=B5*D5)
    assert ws_cfo["E5"].value == "=B5*D5", "Audience Reserve (USD) should be formula-based."
    assert ws_cfo["F5"].value == "=C5*D5", "Treasury (USD) should be formula-based."
    assert ws_cfo["I5"].value == "=H5*38.36*0.012", "Data Asset Value (USD) should be formula-based."
    assert ws_cfo["L5"].value == "=J5/K5", "LTV/CAC Ratio should be formula-based."
    
    # 4. Check Reconciliation Log tab
    ws_recon = wb["Reconciliation Log"]
    assert ws_recon["E5"].value == "RECONCILED"
