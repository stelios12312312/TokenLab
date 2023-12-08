#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Dec  8 13:27:18 2023

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



class TreasuryBasic(Controller):
    
    def __init__(self,fee:float=1):
        self.dependencies={TokenEconomy:None}
        self._fee = fee
        

        self.treasury={}
            
    def add_asset(self,value:float,currency_symbol:str):
        
        if currency_symbol in self.treasury:
            self.treasury[currency_symbol]+=value*fee
        else:
            self.treasury[currency_symbol]=value*fee

        
    def retrieve_assset(self,value:float,currency_symbol:str):
        if currency_symbol in self.treasury:
            self.treasury[currency_symbol]-=value
        else:
            print('Warning! Asset symbol does not exist yet!')
    
    def get_tokeneconomy(self)->TokenEconomy:
        return self.dependencies[TokenEconomy]
    


class TreasuryBurner(Controller):
    """
    Simulates an 'imaginary' treasury that simply burns all tokens allocated to it. It's meant to be used in conjuction with 
    agent pools
    """
    
    def __init__(self,fee:float):
        """
        Parameters
        ----------
        fee : float
            A fee in percentage. This is a fee applied in the total amount of transactions

        Returns
        -------
        None.

        """
        self.dependencies={TokenEconomy:None}
        self._fee = fee
        
        pass
    
    def execute(self,transactions):
        removable_assets = self._fee * transactions
        tokenec = self.get_tokeneconomy()
        
    
    def get_tokeneconomy(self)->TokenEconomy:
        return self.dependencies[TokenEconomy]