PYTHON ?= python3

.PHONY: test
test:
	PYTHONPATH=src $(PYTHON) -m pytest -q
