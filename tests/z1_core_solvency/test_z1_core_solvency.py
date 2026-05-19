import unittest
import pandas as pd
from projects.z1.core_solvency.config import SolvencyConfig
from projects.z1.core_solvency.scenarios import get_scenario_config, generate_stress_grid
from projects.z1.core_solvency.run import run_simulation

class TestZ1CoreSolvency(unittest.TestCase):
    
    def test_config_validation(self):
        config = SolvencyConfig()
        config.validate() # Should not raise
        
        bad_config = SolvencyConfig(cohort_population_shares={"passive_viewers": 0.5}) # Sums to 0.5
        with self.assertRaises(AssertionError):
            bad_config.validate()

    def test_baseline_scenario(self):
        config = get_scenario_config('baseline')
        config.n_epochs = 10 # Short test
        history = run_simulation(config)
        self.assertEqual(len(history), 10)
        
        # Verify invariants didn't crash and we have data
        df = pd.DataFrame(history)
        self.assertIn('ar_ratio', df.columns)
        self.assertIn('treasury', df.columns)
        self.assertIn('total_acr_issued', df.columns)

    def test_grid_generation(self):
        grid = generate_stress_grid()
        self.assertEqual(len(grid), 27)
        names = [n for n, c in grid]
        self.assertEqual(len(set(names)), 27) # All unique

if __name__ == '__main__':
    unittest.main()
