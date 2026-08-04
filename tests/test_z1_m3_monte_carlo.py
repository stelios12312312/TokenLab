import unittest
from projects.z1.m3_full_economy.monte_carlo import run_trial, DISCLAIMER

class TestZ1M3MonteCarlo(unittest.TestCase):
    
    def test_disclaimer_presence(self):
        self.assertIn("not financial advice", DISCLAIMER)
        
    def test_run_trial_structure(self):
        # Run a short simulation: 5 epochs, 1 trial
        df = run_trial(trial_id=0, n_epochs=5)
        
        # Verify columns exist
        self.assertIn("epoch", df.columns)
        self.assertIn("price", df.columns)
        self.assertIn("ar", df.columns)
        self.assertIn("sr", df.columns)
        self.assertIn("shock_occurred", df.columns)
        self.assertIn("trial_id", df.columns)
        
        # Verify lengths: epoch 0 to 5 represents 6 total state rows
        self.assertEqual(len(df), 6)
        
        # Verify trial_id is stored
        self.assertEqual(df["trial_id"].iloc[0], 0)

if __name__ == "__main__":
    unittest.main()
