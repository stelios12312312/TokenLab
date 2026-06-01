import pandas as pd
import numpy as np
from statsmodels.tsa.holtwinters import Holt

# Initial parameters
months = 36  # Original period for historical data
forecast_months = 24  # Forecast period
initial_revenues = {"CA": 10000, "BB": 15000, "DG": 12000}
growth_rates = {"CA": 0.02, "BB": 0.03, "DG": 0.025}

# Create DataFrame for initial 36 months
index = pd.date_range(start="2024-01", periods=months, freq="M")
df_initial = pd.DataFrame(index=index)

# Populate the DataFrame with revenue data, ensuring numerical types
for project, initial_revenue in initial_revenues.items():
    growth_rate = growth_rates[project]
    df_initial[project] = [initial_revenue * (1 + growth_rate) ** month for month in range(months)]
df_initial = df_initial.astype(float)

# Calculate the average revenue for the initial period
df_initial['Average'] = df_initial.mean(axis=1)

# Apply Holt's linear trend method to forecast future revenues
holt_model = Holt(df_initial['Average'], initialization_method="estimated").fit(smoothing_level=0.8, smoothing_trend=0.2, optimized=True)
forecast_values_holt = holt_model.forecast(forecast_months)

# Create DataFrame for the forecasted values
forecast_index = pd.date_range(start=df_initial.index[-1] + pd.offsets.MonthEnd(1), periods=forecast_months, freq='M')
forecast_df = pd.DataFrame(index=forecast_index, columns=df_initial.columns)
forecast_df['Average'] = forecast_values_holt.values  # Populate only the 'Average' column with forecasted values



# Concatenate the original and forecasted data
df_combined = pd.concat([df_initial, forecast_df], axis=0)

# Display the combined DataFrame
print(df_combined.tail(25))

# Optional: Export to Excel
excel_path = "crypto_project_forecast_with_holt.xlsx"
df_combined.to_excel(excel_path)
print(f"Forecast data saved to {excel_path}")
