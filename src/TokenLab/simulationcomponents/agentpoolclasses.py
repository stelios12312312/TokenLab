#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:20:03 2022

@author: stylianoskampakis
"""
from typing import List, Dict,Union
from baseclasses import *
from usergrowthclasses import UserGrowth,UserGrowth_Constant
from transactionclasses import TransactionManagement, TransactionManagement_Constant
from supplyclasses import SupplyStaker
import copy
from typing import TypedDict
from addons import Condition



class AgentPool_Basic(AgentPool):
    """
    Simulates a set of agents. Requires:
        
        1) UserGrowth class, which should be independent
        2) Transaction management class
        3) Currency: this is an arbitrary symbol, but it has to also exist in the TokenEconomy.
    
    So, for this class the execute() function simply runs the users and the transactions controller. 
    
    """

    
    def __init__(self,users_controller:Union[UserGrowth,int],transactions_controller:TransactionManagement,
                 currency:str='$',name:str=None,dumper:bool=False)->None:
        """
        
        users_controller: Controller specifying how the userbase grows over time. If the users controller is an integer,
        then the AgentPool class will simply take it as a constant value for all simulations
        
        transactions_controller: Controller that determines
        currency: the currency this pool represents.
        name: the name of the pool, this can come in very handy during debugging
        dumper: Whether this is an agent pool that only sells tokens
        
        
        """      
        super(AgentPool_Basic,self).__init__()
        if isinstance(users_controller,int):
            users_controller=UserGrowth_Constant(users_controller)
            
        if isinstance(transactions_controller,float) or isinstance(transactions_controller,int):
            transactions_controller=TransactionManagement_Constant(transactions_controller)
            
        self.users_controller=users_controller
        self.users_controller.link(AgentPool,self)
        self.transactions_controller=transactions_controller
        self.transactions_controller.link(AgentPool,self)
        self.currency=currency
        
        self.name=name
        
        self.dependencies={TokenEconomy:None}

        return None
    
    
    def execute(self)->None:
        """
        Runs the agent pool. It increases iterations by 1, and then calculates the new number of users
        and the new number of transactions.
        
        Fields:
            'iterations','num_users','transactions'

        Returns
        -------
        None
            DESCRIPTION.

        """
        self.iteration+=1
        self.num_users = self.users_controller.execute()
        self.transactions = self.transactions_controller.execute()
        
        return None
    
    def test_integrity(self)->bool:
        """
        

        Returns
        -------
        bool
            Returns true if the integrity of the user and the transaction controller is True.

        """
        if not self.users_controller.test_integrity():
            return False
        if not self.transactions_controller.test_integrity():
            return False
        
        return True
    
    def reset(self)->None:
        self.iteration=0
        self.users_controller.reset()
        self.transactions_controller.reset()
        
        
    def get_tokeneconomy(self)->TokenEconomy:
        return self.dependencies[TokenEconomy]

        
class AgentPool_Staking(AgentPool_Basic):
    def __init__(self,users_controller:Union[UserGrowth,int],transactions_controller:TransactionManagement,
                 staking_controller:SupplyStaker,staking_controller_params:dict,
                 currency:str='$',name:str=None,dumper:bool=False,
                 )->None:
        """
        
        users_controller: Controller specifying how the userbase grows over time. If the users controller is an integer,
        then the AgentPool class will simply take it as a constant value for all simulations
        
        transactions_controller: Controller that determines
        currency: the currency this pool represents.
        name: the name of the pool, this can come in very handy during debugging
        dumper: Whether this is an agent pool that only sells tokens
        
        
        """      
        super(AgentPool_Staking,self).__init__(users_controller=users_controller,transactions_controller=transactions_controller,
                                               currency=currency,name=name,dumper=dumper)
        self.staking_controller = staking_controller
        self.staking_controller_params = staking_controller_params
        

        return None
    
    def reset(self)->None:
        self.iteration=0
        self.users_controller.reset()
        self.transactions_controller.reset()
        
    
    def execute(self)->None:
        """
        Runs the agent pool. It increases iterations by 1, and then calculates the new number of users
        and the new number of transactions.
        
        It then creates a number of stakers depending on the number of transactions.
        
        Fields:
            'iterations','num_users','transactions'

        Returns
        -------
        None
            DESCRIPTION.

        """
        self.iteration+=1
        self.num_users = self.users_controller.execute()
        self.transactions = self.transactions_controller.execute()
        
        keys=[]
        for k in self.dependencies.keys():
            keys.append(k)
        token_economy_supply = self.dependencies[keys[0]].supply
        
        if self.transactions > token_economy_supply:
            self.transactions = token_economy_supply*np.random.rand() - 1
        
        number_of_stakers = int(self.transactions/self.staking_controller_params['staking_amount'])
        
        new_pools=[]
        for i in range(number_of_stakers):
            new_pools.append(('SupplyPool',self.staking_controller(**self.staking_controller_params)))
        
        self.new_pools = new_pools
        
        return self.new_pools
    
    
    
        

class AgentPool_Conditional(Initialisable,AgentPool):
    """
    Uses conditions in order connect controllers (user or transaction) to the condition being True.
    
    This class can be used to create very flexible logic-style patterns.
    
    This pool inherits from the Initialisable class. Because of the way connections work, this class has to be
    initialised before its user properly. If connected to a TokenEconomy, then this happens automatically, so the
    user has nothing to worry about.
    """
    
    def __init__(self,users_controller:Union[UserGrowth,int]=None,transactions_controller:TransactionManagement=None,
                 currency:str='$',name:str=None,connect_to_token_economy:bool=True):
        """
        

        Parameters
        ----------
        users_controller : Union[UserGrowth,int], optional
            This is a users controller which runs independently of any conditions. The default is None.
        transactions_controller : TransactionManagement, optional
            Transactions controller which runs independently of any conditions. The default is None.
        currency : str, optional
            Need to specify a currency when using this within a token economy. The default is '$'.
        name : str, optional
            Name of this object. The default is None.
        connect_to_token_economy : bool, optional
            If True, then the Conditions supplied are reading data from the TokenEconomy this pool
            is connected to. Otherwise, they read data from this agent pool itself. The default is True.

        Returns
        -------
        None.

        """
        super(AgentPool_Conditional,self).__init__()
        
        self.conditions_map=[]
        self.dependencies={TokenEconomy:None}
        
        
        self.connect_to_token_economy=connect_to_token_economy

        
        if users_controller!=None and not isinstance(users_controller,int):
            self.users_controller=users_controller
            self.users_controller.link(AgentPool,self)
        elif isinstance(users_controller,int):
            self.users_controller=UserGrowth_Constant(users_controller)
            self.users_controller.link(AgentPool,self)
        else:
            self.users_controller=None
        
            
        if transactions_controller!=None and not isinstance(transactions_controller,int):
            self.transactions_controller=transactions_controller
            self.transactions_controller.link(AgentPool,self)
        elif isinstance(transactions_controller,int):
            self.transactions_controller=TransactionManagement_Constant(transactions_controller)
            self.transactions_controller.link(AgentPool,self)
        else:
            self.transactions_controller=None
            
        self.currency=currency
        
        self.name=name
        self.num_users=0
        self.transactions=0
        
        
    def add_condition(self,condition:Condition,controller:Union[UserGrowth,TransactionManagement])->bool:
        """
        Adds a Condition, which when True, triggers a controller object.

        Parameters
        ----------
        condition : Condition
        controller : Union[UserGrowth,TransactionManagement]
            A user controller or transaction controller object.

        Returns
        -------
        None
            DESCRIPTION.

        """
        
        self.conditions_map.append([condition,controller])
            
        for con in self.conditions_map:
            #link the controller to the agent pool itself
            con[1].link(AgentPool,self)
            #if no simulation component has specified for the condition, simply link it to the TokenEconomy
            #of this agent pool
            if con[0].sim_component==None:
                con[0].sim_component=self.dependencies[TokenEconomy]
                
        return None
                
    def add_conditions(self,conditions:List[Union[Condition,Union[UserGrowth,TransactionManagement]]])->None:
        """
        
        Shortcut for adding multiple conditions in one go.

        Parameters
        ----------
        conditions : List of Conditions and Controllers to add. The format has to be 
        [ [Condition1,Controller1], [Condition2, Controller2] ]

        Returns
        -------
        None

        """
        
        for cond in conditions:
            self.add_condition(cond[0],cond[1])
            
        return None
                    
    def initialise(self)->None:
        """
        Initialises the class. This action connects all objects to the right modules, that is
        either the token economy itself or the agent pools.
        """
        if self.connect_to_token_economy:
            self.connector=self.dependencies[TokenEconomy]
            self.label=TokenEconomy
        else:
            self.label=AgentPool
            self.connector=self
        
        if self.users_controller!=None:
            self.users_controller.link(self.label,self.connector)   
            
        if self.transactions_controller!=None:
            self.transactions_controller.link(self.label,self.connector)
            
        for con in self.conditions_map:
            con[1].link(self.label,self.connector)
            #if the condition has no sim component, then connect to the current token economy
            if con[0].sim_component==None:
                con[0].sim_component=self.dependencies[TokenEconomy]
                
        self.initialised=True
        
        
    def execute(self)->None:
        """
        This function first runs the users controller (if any), then the transactions controller (if any)
        and then all conditions with associated controllers.

        Raises
        ------
        Exception
            If the connection of a condition is not to a controller (user or transaction), then an exception is raised.

        Returns
        -------
        None
            

        """
        self.iteration+=1
        self.transactions=0
        self.num_users=0
        
        if not self.initialised:
            self.initialise()

        if self.users_controller!=None:
            self.num_users+=self.users_controller.execute()
            
        if self.transactions_controller!=None:
            self.transactions+=self.transactions_controller.execute()
        
        for con in self.conditions_map:
            logical_result=con[0].execute()
            if logical_result:
                logical_result=con[0].execute()

                if isinstance(con[1],TransactionManagement):
                    if self.connect_to_token_economy:
                        self.transactions+=con[1].execute('TokenEconomy')
                    else:
                        self.transactions+=con[1].execute('AgentPool')
                elif isinstance(con[1],UserGrowth):
                    self.num_users+=con[1].execute()
                else:
                    raise Exception('The condition was attached to an object that is neither a UserGrowth nor TransactionsManagement class!')        
        return None
        
        
    def reset(self)->None:
        """
        Sets the iteration meter to 0 and resets
        all controllers, including the ones inside conditions.

        """
        self.iteration=0
        for con in self.conditions_map:
            con[1].reset()
            
        if self.users_controller!=None:
            self.users_controller.reset()
            
        if self.transactions_controller!=None:
            self.transactions_controller.reset()
            
    
    def test_integrity(self)->bool:
        """
        Tests the integrity of the controllers and the dependencies.
        """
        if self.dependencies[TokenEconomy]==None:
            return False
        try:
            if not self.users_controller.test_integrity():
                return False
        except:
            pass
        
        try:
            if not self.transactions_controller.test_integrity():
                return False
        except:
            pass
        
        return True

    
        
        