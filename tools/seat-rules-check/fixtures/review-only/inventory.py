def add(bag, item, count):
    bag[item] = bag.get(item, 0) + count

def remove(bag, item, count):
    bag[item] = bag[item] - count
    return bag
