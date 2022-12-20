#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon Dec  5 19:52:42 2022

@author: stylianoskampakis
"""

import pandas as pd
import numpy as np
import statsmodels.api as sm
from typing import List


def stepwise_selection(X:[List], y:[List], 
                       initial_list:[List[str]]=[], 
                       threshold_in:[float]=0.001, 
                       threshold_out:[float] = 0.05, 
                       verbose:[bool]=True,square:[bool]=False):
    """ Perform a forward-backward feature selection 
    based on p-value from statsmodels.api.OLS
    
    Arguments:
        X: pandas.DataFrame with candidate features
        y: list-like with the target
        initial_list: ist of features to start with (column names of X)
        threshold_in: include a feature if its p-value < threshold_in
        threshold_out: exclude a feature if its p-value > threshold_out
        verbose: whether to print the sequence of inclusions and exclusions
        square
        
    Returns: list of selected features 
    
    
    Always set threshold_in < threshold_out to avoid infinite looping.
    
    
    See https://en.wikipedia.org/wiki/Stepwise_regression for the details
    """
    included = list(initial_list)
    
    if square:
        X_squared=X**2
        X_squared.columns+='^2'
        X=pd.concat([X,X_squared],axis=1)
    
    while True:
        changed=False
        # forward step
        excluded = list(set(X.columns)-set(included))
        new_pval = pd.Series(index=excluded)
        for new_column in excluded:
            model = sm.OLS(y, sm.add_constant(pd.DataFrame(X[included+[new_column]]))).fit()
            new_pval[new_column] = model.pvalues[new_column]
        best_pval = new_pval.min()
        if best_pval < threshold_in:
            best_feature = new_pval.idxmin()
            included.append(best_feature)
            changed=True
            if verbose:
                print('Add  {:30} with p-value {:.6}'.format(best_feature, best_pval))

        # backward step
        model = sm.OLS(y, sm.add_constant(pd.DataFrame(X[included]))).fit()
        # use all coefs except intercept
        pvalues = model.pvalues.iloc[1:]
        worst_pval = pvalues.max() # null if pvalues is empty
        if worst_pval > threshold_out:
            changed=True
            worst_feature = pvalues.idxmax()
            included.remove(worst_feature)
            if verbose:
                print('Drop {:30} with p-value {:.6}'.format(worst_feature, worst_pval))
        if not changed:
            break
        
    model = sm.OLS(y,X.loc[:,included]).fit()
    return model,included





