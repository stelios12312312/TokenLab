from TokenLab.simulationcomponents.agentpoolclasses import AgentPool_Basic
from typing import List

class AgentPool_Z1(AgentPool_Basic):
    """
    Subclasses TokenLab's native AgentPool to hold Z1-specific cohort state:
    Vesting buckets, available ACR, pending queue requests, and cohort-level parameters.
    """
    def __init__(self, name: str, config: 'SolvencyConfig'):
        # Bypass User/Transaction controllers by feeding simple ints or keeping them None
        # We handle iteration logic explicitly in TokenEconomy_Z1
        super().__init__(users_controller=0, transactions_controller=0, name=name, currency="Z1U")
        
        # Load Z1 configurations
        self.population = int(config.initial_viewers * config.cohort_population_shares[name])
        self.claim_rate = config.claim_rate_by_cohort[name]
        self.verification_pass_rate = config.verification_pass_rate_by_cohort[name]
        self.acr_issue_rate = config.acr_issue_rate_by_cohort[name]
        self.settle_propensity = config.settle_propensity_by_cohort[name]
        self.utility_spend_rate = config.utility_spend_rate_by_cohort[name]
        
        # M1 Specific State
        self.cumulative_claimed_population = 0
        self.cumulative_verified_population = 0
        self.acr_vesting_buckets: List[float] = [0.0] * (config.vesting_lag_epochs + getattr(config, 'vesting_sub_cohort_phases', 1) - 1)
        
        # PCS & BAS (GAP-01, GAP-02, GAP-04)
        self.tenure_epochs = 0
        self.activity_score = 0.0
        self.pcs_score = 0.0
        self.bas_score = 0.0
        self.cumulative_pcs = 0.0
        self.tier = "Bronze"
        self.acr_available = 0.0
        self.acr_queued_for_settlement = 0.0
        self.acr_settled = 0.0
        self.acr_held = 0.0
        self.acr_voided = 0.0
        self.z1u_balance = 0.0
        
        # M3 Governance Staking (US-Z1-M3-06)
        self.staked_z1u = 0.0
        self.staking_buckets = [0.0] * getattr(config, 'staking_lock_epochs', 12) if getattr(config, 'governance_staking_enabled', False) else []
        
        # To maintain compatibility with TokenLab's AgentPool metrics:
        # num_users tracks cumulative claimed users for TokenLab metrics tracking.
        self.num_users = 0
        self.transactions = 0

    def execute(self) -> None:
        """
        We purposefully DO NOT use the standard AgentPool_Basic execute() method
        because the Z1 architecture demands a strict 5-step loop (Vest -> Settle -> Spend)
        orchestrated entirely by TokenEconomy_Z1.
        
        However, calling this increments iteration to satisfy base-class compatibility.
        """
        self.iteration += 1
