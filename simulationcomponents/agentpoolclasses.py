#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Nov 18 12:20:03 2022

@author: stylianoskampakis
"""
from typing import List, Dict,Union
from .baseclasses import *
from .usergrowthclasses import UserGrowth,UserGrowth_Constant
from .transactionclasses import TransactionManagement, TransactionManagement_Constant
import copy

class AgentPool():
    
    def __init__(self):
        
        self.num_users=None
        self.transactions=None
        self.iteration=0
        self.currency=None
        self.name=None
        
        self.transactions_controller=None
        

    def __print__(self)->str:
        users=self.num_users
        trans=self.transactions_controller.transactions_value
        
        return str(users)+'\n'+str(trans)
    
    def report(self)->Dict:
        """
        Returns user and transaction data from the current iteration
        """
        rep={'users':self.num_users,'transactions':self.transactions_controller.transactions_value}
        
        
        return rep
    
    def get_transactions(self)->float:
        
        return self.transactions
    
    def get_num_users(self)->int:
        
        return self.num_users
    
    def reset(self)->None:
        
        self.iteration=0



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
        then the AgentPool class will simply take it as a constant valeu for all simulations
        
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
        self.transactions_controller=transactions_controller
        self.transactions_controller.link(UserGrowth,self.users_controller)
        self.currency=currency
        
        self.name=name
        
        return None
    
    
    def execute(self)->None:
        self.iteration+=1
        self.num_users = self.users_controller.execute()
        self.transactions = self.transactions_controller.execute()
        
        return None
    
    def test_integrity(self)->bool:
        if not self.users_controller.test_integrity():
            return False
        if not self.transactions_controller.test_integrity():
            return False
        
        return True
    
    def reset(self)->None:
        self.iteration=0
        self.users_controller.reset()
        self.transactions_controller.reset()
        

    
class AgentPool_Conditional(AgentPool):
    pass
    

    
        
        