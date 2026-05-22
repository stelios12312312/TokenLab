class AutomatedMarketMaker:
    """
    Constant-product Automated Market Maker (x * y = k) for Z1U/USD.
    Provides endogenous pricing and slippage mechanics for the Z1 ecosystem.
    """
    def __init__(self, z1u_reserve: float, usd_reserve: float, fee_rate: float = 0.003):
        self.z1u_reserve = z1u_reserve
        self.usd_reserve = usd_reserve
        self.k = z1u_reserve * usd_reserve
        self.fee_rate = fee_rate
        self.total_volume_usd = 0.0
        self.initial_spot_price = self.spot_price

    @property
    def spot_price(self) -> float:
        """Current spot price of Z1U in USD."""
        if self.z1u_reserve == 0:
            return 0.0
        return self.usd_reserve / self.z1u_reserve

    def sell_z1u(self, z1u_amount: float) -> float:
        """
        User sells Z1U to the AMM for USD.
        Returns the amount of USD received (after slippage and fees).
        """
        if z1u_amount <= 0:
            return 0.0

        # Apply fee to the input amount
        z1u_in_with_fee = z1u_amount * (1.0 - self.fee_rate)
        
        # Constant product: (z1u_reserve + z1u_in_with_fee) * (usd_reserve - usd_out) = k
        new_z1u_reserve = self.z1u_reserve + z1u_in_with_fee
        new_usd_reserve = self.k / new_z1u_reserve
        usd_out = self.usd_reserve - new_usd_reserve

        # Update state
        self.z1u_reserve += z1u_amount  # Total Z1U goes into the pool (including fee portion)
        self.usd_reserve -= usd_out
        self.k = self.z1u_reserve * self.usd_reserve # Recompute k due to fees

        self.total_volume_usd += usd_out
        return usd_out

    def buy_z1u(self, usd_amount: float) -> float:
        """
        User buys Z1U from the AMM using USD.
        Returns the amount of Z1U received.
        """
        if usd_amount <= 0:
            return 0.0

        # Apply fee to the input amount
        usd_in_with_fee = usd_amount * (1.0 - self.fee_rate)
        
        # Constant product: (usd_reserve + usd_in_with_fee) * (z1u_reserve - z1u_out) = k
        new_usd_reserve = self.usd_reserve + usd_in_with_fee
        new_z1u_reserve = self.k / new_usd_reserve
        z1u_out = self.z1u_reserve - new_z1u_reserve

        # Update state
        self.usd_reserve += usd_amount
        self.z1u_reserve -= z1u_out
        self.k = self.z1u_reserve * self.usd_reserve

        self.total_volume_usd += usd_amount
        return z1u_out

    def compute_settlement_ratio(self, base_ratio: float) -> float:
        """
        Compute dynamic settlement ratio based on AMM health or price action.
        If price drops, the ratio drops to protect the AR (dynamic slippage/peg defense).
        """
        if self.initial_spot_price > 0:
            price_health = self.spot_price / self.initial_spot_price
        else:
            price_health = 1.0
            
        # M2 Dynamic Policy: cap at base_ratio, penalize if price < initial
        return base_ratio * min(1.0, price_health)
