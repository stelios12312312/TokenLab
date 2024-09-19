#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:20:03 2022

@author: stylianoskampakis
"""
from typing import List, Dict, Union
from baseclasses import *
from usergrowthclasses import UserGrowth, UserGrowth_Constant, UserGrowth_FromData
from supplyclasses import SupplyStaker, SupplyController_Burn
import copy
from typing import TypedDict
from addons import Condition
import warnings
from transactionclasses import (
    TransactionManagement,
    TransactionManagement_Constant,
    TransactionManagement_Stochastic,
    TransactionManagement_FromData,
)
from treasuryclasses import TreasuryBasic


class AgentPool_Basic(AgentPool, Initialisable):
    """
    Simulates a set of agents within a token economy.

    Requires:
    1) UserGrowth class to manage user growth over time.
    2) Transaction management class to handle transactions.
    3) Currency: an arbitrary symbol that must exist within the TokenEconomy.

    This class's `execute()` function runs the user and transaction controllers at each iteration.
    """

    def __init__(
        self,
        # User and transaction controllers
        users_controller: Union[UserGrowth, int] = 1,
        transactions_controller: TransactionManagement = 1,
        # Currency and identification
        currency: str = "$",
        name: str = None,
        # Behavior settings
        dumper: bool = False,
        chained: bool = False,
        # Treasury and fee settings
        treasury: TreasuryBasic = None,
        fee: float = None,
        fee_type: str = "perc",
        # Activation settings
        activation_iteration: float = 0,
    ) -> None:
        """
        Initializes the AgentPool_Basic class.

        User and Transaction Controllers:
        - users_controller: Controller specifying how the user base grows over time.
                            If an integer, it is treated as a constant value.
        - transactions_controller: Controller that manages transactions.

        Currency and Identification:
        - currency: The currency this pool represents.
        - name: The name of the pool (useful for debugging).

        Behavior Settings:
        - dumper: Whether this agent pool only sells tokens.
        - chained: If True, uses another agent pool's user base instead of executing its own user controller.

        Treasury and Fee Settings:
        - treasury: An optional treasury to manage fees collected by this agent pool.
        - fee: The fee rate or amount collected by the treasury.
        - fee_type: Type of fee, either 'perc' for percentage (fee * transaction value) or 'fixed' for a fixed amount per transaction (fee * transaction number).

        Activation Settings:
        - activation_iteration: The iteration at which this agent pool becomes active.
        """

        # Initialize parent classes and fields
        super(AgentPool_Basic, self).__init__()
        self.name = name
        self.currency = currency
        self.chained = chained
        self.fee = fee
        self.activation_iteration = activation_iteration
        self.dependencies = {TokenEconomy: None}

        # Initialize user and transaction controllers based on their types
        self.users_controller = self._initialize_users_controller(users_controller)
        self.transactions_controller = self._initialize_transactions_controller(
            transactions_controller
        )

        # Link controllers to the agent pool dependencies
        self.users_controller.link(AgentPool, self)
        self.transactions_controller.link(AgentPool, self)

        # Treasury and fee setup
        self.treasury = treasury
        self.fee_type = self._validate_fee_type(fee_type)
        self._validate_treasury_fee_setup()

        return None

    def _initialize_users_controller(
        self, users_controller: Union[UserGrowth, int]
    ) -> UserGrowth:
        """
        Initializes the users controller based on the input type.

        Parameters:
        - users_controller: The users controller, can be an integer or a UserGrowth instance.

        Returns:
        - A UserGrowth instance.
        """
        if isinstance(users_controller, int):
            if users_controller == 1:
                print(f"Warning! Users set to 1 for agent pool with name: {self.name}")
            return UserGrowth_Constant(users_controller)
        elif isinstance(users_controller, list):
            return UserGrowth_FromData(users_controller)
        return users_controller

    def _initialize_transactions_controller(
        self, transactions_controller: Union[TransactionManagement, float, int]
    ) -> TransactionManagement:
        """
        Initializes the transactions controller based on the input type.

        Parameters:
        - transactions_controller: The transactions controller, can be a float, int, or TransactionManagement instance.

        Returns:
        - A TransactionManagement instance.
        """
        if isinstance(transactions_controller, (float, int)):
            return TransactionManagement_Constant(transactions_controller)
        elif isinstance(transactions_controller, list):
            return TransactionManagement_FromData(transactions_controller)
        return transactions_controller

    def _validate_fee_type(self, fee_type: str) -> str:
        """
        Validates the fee type to ensure it's either 'perc' or 'fixed'.

        Parameters:
        - fee_type: The type of fee ('perc' or 'fixed').

        Returns:
        - The validated fee type.

        Raises:
        - Exception: If the fee type is invalid.
        """
        if fee_type not in ["perc", "fixed"]:
            raise Exception('fee_type must be either "perc" or "fixed".')
        return fee_type

    def _validate_treasury_fee_setup(self) -> None:
        """
        Validates the setup of the treasury and fee, ensuring compatibility.

        Raises:
        - Exception: If the treasury is defined without a fee, or if the fee type is incompatible.
        """
        if self.treasury is not None:
            if self.fee is None:
                raise Exception(
                    "When using a treasury within an agent pool, you must also define a fee."
                )
            if self.fee_type == "fixed" and not isinstance(
                self.transactions_controller, TransactionManagement_Stochastic
            ):
                warnings.warn(
                    "Warning! Fixed fee type requires TransactionsManagement_Stochastic "
                    "as it needs an estimation of the total number of transactions."
                )

    def execute(self) -> None:
        """
        Executes the agent pool's actions for a single iteration.

        This method updates the number of users and transactions based on the controllers,
        applies any treasury fees, and increments the iteration counter.

        Returns:
        - None
        """

        # If the agent pool is not yet active, skip execution and increment the iteration counter
        if self.iteration < self.activation_iteration:
            self.iteration += 1
            return None

        # Execute the user and transaction controllers if the pool is active
        if not self.chained:
            self.num_users = self.users_controller.execute()
            if self.num_users < 0:
                raise Exception(
                    f"Negative users detected in agent pool with name: {self.name}"
                )
        else:
            # Use the number of users from the chained agent pool
            self.num_users = self.users_controller.num_users

        # Execute the transaction controller
        self.transactions = self.transactions_controller.execute()

        # If a treasury is defined, execute it to collect fees
        if self.treasury is not None:
            if self.fee_type == "perc":
                self.treasury.execute(
                    currency_symbol=self.currency, value=self.transactions * self.fee
                )
            else:
                value = self.transactions * self.fee
                self.treasury.execute(value=value, currency_symbol=self.currency)

        self.iteration += 1
        return None

    def initialise(self):
        """
        Initializes the agent pool, linking the treasury if it exists.

        This method is called before the simulation begins to ensure all dependencies are set up.
        """
        if self.treasury is not None:
            self.treasury.link(AgentPool, self)
        self.initialised = True

    def test_integrity(self) -> bool:
        """
        Tests the integrity of the agent pool's controllers.

        Returns:
        - True if both the user and transaction controllers pass their integrity tests.
        """
        return (
            self.users_controller.test_integrity()
            and self.transactions_controller.test_integrity()
        )

    def reset(self) -> None:
        """
        Resets the agent pool's iteration counter and controllers.

        This method is used to restart the simulation from the beginning.
        """
        self.iteration = 0
        self.users_controller.reset()
        self.transactions_controller.reset()

    def get_tokeneconomy(self) -> TokenEconomy:
        """
        Returns the linked TokenEconomy instance.

        Returns:
        - The TokenEconomy instance linked to this agent pool.
        """
        return self.dependencies[TokenEconomy]

    def get_num_transactions(self) -> int:
        """
        Returns the number of transactions processed by this agent pool.

        Returns:
        - The number of transactions.
        """
        return self.transactions_controller.get_num_transactions()


class AgentPool_BuyBack(AgentPool_Basic):
    """
    A specialized AgentPool that handles buyback operations.

    This class extends AgentPool_Basic by implementing a buyback mechanism, where
    tokens are bought back and burned based on the transaction volume.
    """

    def __init__(
        self,
        # Controllers
        users_controller: Union[UserGrowth, int],
        transactions_controller: TransactionManagement,
        # Currency and Identification
        currency: str = "$",
        name: str = None,
        # Behavior Settings
        dumper: bool = False,
        chained: bool = False,
        # Treasury and Fee Settings
        treasury: TreasuryBasic = None,
        fee: float = 0,
        fee_type: str = "perc",
    ) -> None:
        """
        Initializes the AgentPool_BuyBack class.

        Controllers:
        - users_controller: Controller specifying how the user base grows over time.
                            If an integer, it is treated as a constant value.
        - transactions_controller: Controller that determines the transaction volume.

        Currency and Identification:
        - currency: The currency this pool represents.
        - name: The name of the pool (useful for debugging).

        Behavior Settings:
        - dumper: Whether this agent pool only sells tokens.
        - chained: If True, uses another agent pool's user base instead of executing its own user controller.

        Treasury and Fee Settings:
        - treasury: An optional treasury to manage fees collected by this agent pool.
        - fee: The fee rate or amount collected by the treasury.
        - fee_type: Type of fee, either 'perc' for percentage or 'fixed' for a fixed amount.
        """

        # Initialize the parent class
        super(AgentPool_BuyBack, self).__init__(
            users_controller=users_controller,
            transactions_controller=transactions_controller,
            currency=currency,
            name=name,
            dumper=dumper,
            chained=chained,
            treasury=treasury,
            fee=fee,
            fee_type=fee_type,
        )

    def execute(self) -> None:
        """
        Executes the agent pool's actions for a single iteration.

        This method updates the number of users and transactions based on the controllers,
        then calculates the total tokens to be bought back based on the transaction volume.

        The bought-back tokens are burned via a SupplyController_Burn instance.

        Returns:
        - A list containing the created SupplyPool with the burn controller.
        """

        # Increment iteration counter
        self.iteration += 1

        # Update number of users
        if not self.chained:
            self.num_users = self.users_controller.execute()
        else:
            self.num_users = self.users_controller.num_users

        # Execute the transaction controller
        self.transactions = self.transactions_controller.execute()

        # Calculate the total number of tokens to be bought back based on the transaction volume and token price
        total_tokens_bought = self.transactions / self.dependencies[TokenEconomy].price

        # Create a SupplyController_Burn instance to burn the bought-back tokens
        sup = SupplyController_Burn(
            burn_param=total_tokens_bought, burn_style="fixed", self_destruct=True
        )
        sup.link(TokenEconomy, self.dependencies[TokenEconomy])

        # Return the new SupplyPool with the burn controller
        return [("SupplyPool", sup)]

    def reset(self) -> None:
        """
        Resets the agent pool's iteration counter and controllers.

        This method is used to restart the simulation from the beginning.
        """
        self.iteration = 0
        self.users_controller.reset()
        self.transactions_controller.reset()


class AgentPool_Staking(AgentPool_Basic):
    """
    A specialized AgentPool that handles staking operations.

    This class extends AgentPool_Basic by adding staking functionality. It manages users,
    transactions, and the creation of stakers based on the transaction volume.
    """

    def __init__(
        self,
        # Controllers
        users_controller: Union[UserGrowth, int],
        transactions_controller: TransactionManagement,
        staking_controller: SupplyStaker,
        staking_controller_params: dict,
        # Currency and Identification
        currency: str = "$",
        name: str = None,
        # Behavior Settings
        dumper: bool = False,
        chained: bool = False,
        # Treasury and Fee Settings
        treasury: TreasuryBasic = None,
        fee: float = 0,
        fee_type: str = "perc",
    ) -> None:
        """
        Initializes the AgentPool_Staking class.

        Controllers:
        - users_controller: Controller specifying how the user base grows over time.
                            If an integer, it is treated as a constant value.
        - transactions_controller: Controller that determines the transaction volume.
        - staking_controller: A controller responsible for creating stakers.
        - staking_controller_params: Parameters for the staking controller.

        Currency and Identification:
        - currency: The currency this pool represents.
        - name: The name of the pool (useful for debugging).

        Behavior Settings:
        - dumper: Whether this agent pool only sells tokens.
        - chained: If True, uses another agent pool's user base instead of executing its own user controller.

        Treasury and Fee Settings:
        - treasury: An optional treasury to manage fees collected by this agent pool.
        - fee: The fee rate or amount collected by the treasury.
        - fee_type: Type of fee, either 'perc' for percentage or 'fixed' for a fixed amount.
        """

        # Initialize the parent class
        super(AgentPool_Staking, self).__init__(
            users_controller=users_controller,
            transactions_controller=transactions_controller,
            currency=currency,
            name=name,
            dumper=dumper,
            chained=chained,
            treasury=treasury,
            fee=fee,
            fee_type=fee_type,
        )

        # Initialize staking-specific attributes
        self.staking_controller = staking_controller
        self.staking_controller_params = staking_controller_params

    def reset(self) -> None:
        """
        Resets the agent pool's iteration counter and controllers.

        This method is used to restart the simulation from the beginning.
        """
        self.iteration = 0
        self.users_controller.reset()
        self.transactions_controller.reset()

    def execute(self) -> None:
        """
        Executes the agent pool's actions for a single iteration.

        This method updates the number of users and transactions based on the controllers,
        then calculates the number of stakers based on the transaction volume.

        It also updates the treasury (if any) and creates new staking pools.

        Returns:
        - A list of new pools created during this iteration.
        """

        # Increment iteration counter
        self.iteration += 1

        # Update number of users
        if not self.chained:
            self.num_users = self.users_controller.execute()
        else:
            self.num_users = self.users_controller.num_users

        # Execute the transaction controller
        self.transactions = self.transactions_controller.execute()

        # Ensure the transaction volume does not exceed the total token supply
        token_economy_supply = self.get_tokeneconomy().supply
        if self.transactions > token_economy_supply:
            self.transactions = token_economy_supply * np.random.rand() - 1

        # Calculate staking amount per stakers, and then number of stakers
        staking_amount = self._calculate_staking_amount()
        number_of_stakers = int(self.transactions / staking_amount)

        # Update treasury if applicable
        self._update_treasury()

        # Create new staking pools
        self.new_pools = self._create_staking_pools(number_of_stakers)
        return self.new_pools

    def _calculate_staking_amount(self) -> float:
        """
        Calculates the staking amount based on the staking controller parameters.

        Returns:
        - The calculated staking amount.
        """
        try:
            staking_amount = (
                self.staking_controller_params["staking_amount"]
                - self.staking_controller_params["staking_amount"] * self.fee
            )
        except:
            staking_amount = self.staking_controller_params["staking_amount"].rvs(1)[0]
            staking_amount = staking_amount - staking_amount * self.fee

        return staking_amount

    def _update_treasury(self) -> None:
        """
        Updates the treasury with the collected fees based on the transactions.

        This method handles both percentage-based and fixed fees.
        """
        if self.treasury is not None:
            if self.fee_type == "perc":
                total_fee = self.transactions * self.fee
            else:
                total_fee = self.fee

            self.treasury.execute(currency_symbol=self.currency, value=total_fee)

    def _create_staking_pools(self, number_of_stakers: int) -> list:
        """
        Creates new staking pools based on the number of stakers calculated.

        Parameters:
        - number_of_stakers: The number of stakers to create.

        Returns:
        - A list of new staking pools created.
        """
        new_pools = []
        for _ in range(number_of_stakers):
            new_staker = self.staking_controller(**self.staking_controller_params)
            new_staker.link(AgentPool, self)
            new_staker.execute()
            new_pools.append(("SupplyPool", new_staker))

        return new_pools


class AgentPool_Conditional(Initialisable, AgentPool):
    """
    Uses conditions to connect controllers (user or transaction) to the condition being True.

    This class allows for creating flexible logic patterns by executing controllers
    based on specified conditions. It inherits from the Initialisable class and must be
    initialized before use. When connected to a TokenEconomy, initialization happens automatically.
    """

    def __init__(
        self,
        # Controllers
        users_controller: Union[UserGrowth, int] = None,
        transactions_controller: TransactionManagement = None,
        # Currency and Identification
        currency: str = "$",
        name: str = None,
        # Connection and Dependency Settings
        connect_to_token_economy: bool = True,
        # Treasury and Fee Settings
        treasury: TreasuryBasic = None,
        fee: float = None,
    ):
        """
        Initializes the AgentPool_Conditional class.

        Controllers:
        - users_controller: A users controller that runs independently of any conditions.
                            If an integer, it is treated as a constant value. Default is None.
        - transactions_controller: Transactions controller that runs independently of any conditions. Default is None.

        Currency and Identification:
        - currency: The currency this pool represents, needed when using within a token economy. Default is '$'.
        - name: The name of the pool, useful for debugging. Default is None.

        Connection and Dependency Settings:
        - connect_to_token_economy: If True, conditions read data from the connected TokenEconomy.
                                    Otherwise, they read data from this agent pool. Default is True.

        Treasury and Fee Settings:
        - treasury: An optional treasury to manage fees collected by this agent pool. Default is None.
        - fee: The fee rate to be collected by the treasury, must be a float in the range [0,1]. Default is None.

        Raises:
        - Exception: If a treasury is provided without a corresponding fee.
        """

        super(AgentPool_Conditional, self).__init__()

        # Initialize basic attributes
        self.conditions_map = []
        self.dependencies = {TokenEconomy: None}
        self.connect_to_token_economy = connect_to_token_economy
        self.currency = currency
        self.name = name
        self.num_users = 0
        self.transactions = 0

        # Initialize controllers
        if users_controller is not None and not isinstance(users_controller, int):
            self.users_controller = users_controller
            self.users_controller.link(AgentPool, self)
        elif isinstance(users_controller, int):
            self.users_controller = UserGrowth_Constant(users_controller)
            self.users_controller.link(AgentPool, self)
        else:
            self.users_controller = None

        if transactions_controller is not None and not isinstance(
            transactions_controller, int
        ):
            self.transactions_controller = transactions_controller
            self.transactions_controller.link(AgentPool, self)
        elif isinstance(transactions_controller, int):
            self.transactions_controller = TransactionManagement_Constant(
                transactions_controller
            )
            self.transactions_controller.link(AgentPool, self)
        else:
            self.transactions_controller = None

        # Treasury and fee setup
        if fee is None and treasury is not None:
            raise Exception(
                "When using a treasury within an agent pool, you must define a fee as a float in the range [0,1]."
            )
        self.treasury = treasury
        self.fee = fee

    def add_condition(
        self, condition: Condition, controller: Union[UserGrowth, TransactionManagement]
    ) -> bool:
        """
        Adds a Condition, which when True, triggers a controller object.

        Parameters:
        - condition: A Condition instance to evaluate.
        - controller: A UserGrowth or TransactionManagement controller to execute when the condition is True.

        Returns:
        - bool: True if the condition and controller were successfully added.
        """

        self.conditions_map.append([condition, controller])

        for condition_, controller_ in self.conditions_map:
            # Link the controller to the agent pool
            controller_.link(AgentPool, self)
            # If no simulation component is specified for the condition, link it to the TokenEconomy
            if condition_.sim_component is None:
                condition_.sim_component = self.dependencies[TokenEconomy]

        return True

    def add_conditions(
        self,
        conditions: List[Union[Condition, Union[UserGrowth, TransactionManagement]]],
    ) -> None:
        """
        Adds multiple conditions and their associated controllers at once.

        Parameters:
        - conditions: A list of [Condition, Controller] pairs to add.

        Returns:
        - None
        """

        for cond in conditions:
            self.add_condition(cond[0], cond[1])

    def initialise(self) -> None:
        """
        Initializes the class by connecting all objects to the appropriate modules,
        either the TokenEconomy or the AgentPool.
        """

        if self.connect_to_token_economy:
            self.connector = self.dependencies[TokenEconomy]
            self.label = TokenEconomy
        else:
            self.label = AgentPool
            self.connector = self

        if self.users_controller is not None:
            self.users_controller.link(self.label, self.connector)

        if self.transactions_controller is not None:
            self.transactions_controller.link(self.label, self.connector)

        for con in self.conditions_map:
            con[1].link(self.label, self.connector)
            # If the condition has no sim component, connect it to the current TokenEconomy
            if con[0].sim_component is None:
                con[0].sim_component = self.dependencies[TokenEconomy]

        if self.treasury is not None:
            self.treasury.link(AgentPool, self)

        self.initialised = True

    def execute(self) -> None:
        """
        Executes the agent pool's actions for a single iteration.

        This method performs the following steps:
        1. Increments the iteration counter.
        2. Resets the transactions and user counts.
        3. Initializes the agent pool if not already initialized.
        4. Executes the user and transaction controllers (if any).
        5. Processes treasury fees (if a treasury is defined).
        6. Evaluates conditions and executes associated controllers when conditions are true.

        Raises:
        - Exception: If a condition is connected to an object that is neither UserGrowth nor TransactionManagement.

        Returns:
        - None
        """

        # Step 1: Increment the iteration counter
        self.iteration += 1

        # Step 2: Reset transactions and user counts for this iteration
        self.transactions = 0
        self.num_users = 0

        # Step 3: Ensure the agent pool is initialized
        if not self.initialised:
            self.initialise()

        # Step 4: Execute the user controller if it exists
        if self.users_controller is not None:
            self.num_users += self.users_controller.execute()

        # Execute the transaction controller if it exists
        if self.transactions_controller is not None:
            self.transactions += self.transactions_controller.execute()

        # Step 5: Process treasury fees if a treasury is defined
        if self.treasury is not None:
            self.treasury.execute(
                currency_symbol=self.currency, value=self.transactions * self.fee
            )

        # Step 6: Evaluate conditions and execute associated controllers
        for condition, controller in self.conditions_map:
            # condition.execute() returns True if the condition is met
            if condition.execute():
                if isinstance(controller, TransactionManagement):
                    # Execute transaction controller based on connection type
                    if self.connect_to_token_economy:
                        self.transactions += controller.execute("TokenEconomy")
                    else:
                        self.transactions += controller.execute("AgentPool")
                elif isinstance(controller, UserGrowth):
                    # Execute user growth controller
                    self.num_users += controller.execute()
                else:
                    # Raise an exception if the controller type is invalid
                    raise Exception(
                        "The condition was attached to an object that is neither a UserGrowth nor TransactionManagement class!"
                    )

    def reset(self) -> None:
        """
        Resets the iteration counter and all controllers, including those within conditions.

        Returns:
        - None
        """

        self.iteration = 0
        for con in self.conditions_map:
            con[1].reset()

        if self.users_controller is not None:
            self.users_controller.reset()

        if self.transactions_controller is not None:
            self.transactions_controller.reset()

    def test_integrity(self) -> bool:
        """
        Tests the integrity of the controllers and the dependencies.

        Returns:
        - bool: True if the integrity check passes.
        """

        if self.dependencies[TokenEconomy] is None:
            return False

        try:
            if not self.users_controller.test_integrity():
                return False
        except AttributeError:
            pass

        try:
            if not self.transactions_controller.test_integrity():
                return False
        except AttributeError:
            pass

        return True
    
    def get_num_transactions(self) -> int:
        """
        Returns the number of transactions processed by this agent pool.

        Returns:
        - The number of transactions.
        """
        if self.transactions_controller:
            return self.transactions_controller.get_num_transactions()
        else:
            return 0
