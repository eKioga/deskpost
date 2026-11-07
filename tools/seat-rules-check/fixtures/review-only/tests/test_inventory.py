from inventory import add

def test_add():
    bag = {}
    add(bag, "rope", 2)
    assert bag["rope"] == 2
