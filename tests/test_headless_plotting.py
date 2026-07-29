# @planner:story = US-PM-AUTO-006
# @planner:proves = crit:CRIT-001, crit:CRIT-002, crit:CRIT-003

import pandas as pd
import pytest
from matplotlib import pyplot as plt
from matplotlib.figure import Figure

from TokenLab.simulationcomponents import tokeneconomyclasses
from TokenLab.simulationcomponents.tokeneconomyclasses import (
    TokenEconomy_Basic,
    TokenMetaSimulator,
)


def _simulator_with_data():
    economy = TokenEconomy_Basic(
        holding_time=1,
        supply=1_000,
        initial_price=1,
    )
    simulator = TokenMetaSimulator(economy)
    simulator.data = pd.DataFrame(
        {
            "iteration_time": [0, 0, 1, 1],
            "token_price": [1.0, 3.0, 2.0, 4.0],
        }
    )
    return simulator


def _fail_on_pyplot_show():
    pytest.fail("get_timeseries requested implicit pyplot display")


def test_get_timeseries_is_headless_by_default(monkeypatch):
    monkeypatch.setattr(tokeneconomyclasses.plt, "show", _fail_on_pyplot_show)
    simulator = _simulator_with_data()

    try:
        plot, data = simulator.get_timeseries("token_price")
    finally:
        plt.close("all")

    assert plot is None
    assert data["token_price_median"].tolist() == [2.0, 3.0]


def test_get_timeseries_can_explicitly_show_figure(monkeypatch):
    shown_figures = []
    monkeypatch.setattr(tokeneconomyclasses.plt, "show", _fail_on_pyplot_show)
    monkeypatch.setattr(Figure, "show", lambda figure: shown_figures.append(figure))
    simulator = _simulator_with_data()

    try:
        plot, data = simulator.get_timeseries("token_price", show=True)
    finally:
        plt.close("all")

    assert plot is None
    assert data["token_price_median"].tolist() == [2.0, 3.0]
    assert len(shown_figures) == 1


def test_show_is_ignored_when_plotting_is_disabled(monkeypatch):
    monkeypatch.setattr(tokeneconomyclasses.plt, "show", _fail_on_pyplot_show)
    monkeypatch.setattr(
        tokeneconomyclasses.plt,
        "plot",
        lambda *args, **kwargs: pytest.fail("plot=False constructed a plot"),
    )
    simulator = _simulator_with_data()

    plot, data = simulator.get_timeseries("token_price", plot=False, show=True)

    assert plot is None
    assert data["token_price_median"].tolist() == [2.0, 3.0]
