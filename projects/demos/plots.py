#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sun Dec 24 17:58:10 2023

@author: stylianoskampakis
"""

import scipy.stats
import matplotlib.pyplot as plt

# Generate sample data
data = scipy.stats.poisson(0.3).rvs(1000)
data=scipy.stats.norm(**{'loc':2,'scale':10}).rvs(2000)

# Calculate weights for each data point so that the histogram sums to 1 (i.e., 100%)
weights = [1 / len(data)] * len(data)

# Plot the histogram with percentages
plt.hist(data, weights=weights)

# Set the y-axis to display percentages
plt.gca().yaxis.set_major_formatter(plt.matplotlib.ticker.PercentFormatter(xmax=1, decimals=0))

# Set the x-axis label
#plt.xlabel('distribution of num transactions per month for a typical user')
plt.xlabel('Average transaction per user in $')


# Show the plot
plt.show()