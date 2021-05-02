import { SFRPG } from "../config.js";
import { RPC } from "../rpc.js";

import { value_equals } from "../utils/value_equals.js";

export function initializeRemoteInventory() {
    RPC.registerCallback("createItemCollection", "gm", onCreateItemCollection);
    RPC.registerCallback("dragItemToCollection", "gm", onItemDraggedToCollection);
    RPC.registerCallback("dragItemFromCollectionToPlayer", "gm", onItemCollectionItemDraggedToPlayer);
    RPC.registerCallback("raiseInventoryWarning", "local", onInventoryWarningReceived);
}

/**
 * Adds the specified quantity of a given item to an actor. Returns the (possibly newly created) item on the target actor.
 * Will not add child items, those will have to be added manually at a later iteration.
 * 
 * @param {ActorItemHelper} targetActor Actor to add the item to.
 * @param {Item} item Item to add.
 * @param {Number} quantity Quantity of the item to add.
 * @param {Item} targetItem (Optional) Item to either merge with, or add as a child to, or find its parent and set as a sibling.
 * @returns {Item} Returns the (possibly newly created) item on the target actor.
 */
export async function addItemToActorAsync(targetActor, itemToAdd, quantity, targetItem = null, targetItemStorageIndex = null) {
    if (!ActorItemHelper.IsValidHelper(targetActor)) return null;

    if (targetItem && targetItem === itemToAdd) {
        return itemToAdd;
    }

    let newItemData = duplicate(itemToAdd);
    newItemData.data.quantity = quantity;

    let desiredParent = null;
    if (targetItem) {
        if (acceptsItem(targetItem, itemToAdd, targetActor.actor)) {
            desiredParent = targetItem;
        } else if (targetItem.name === itemToAdd.name && !containsItems(targetItem) && !containsItems(itemToAdd)) {
            const targetItemNewQuantity = Number(targetItem.data.data.quantity) + quantity;
            await targetActor.updateOwnedItem({ id: targetItem.id, 'data.quantity': targetItemNewQuantity});
            return targetItem;
        } else {
            desiredParent = targetActor.findItem(x => x.data.container?.contents && x.data.container.contents.find(y => y.id === targetItem.id));
        }
    }
    
    let addedItem = null;
    if (targetActor.isToken) {
        const created = await Entity.prototype.createEmbeddedEntity.call(targetActor.actor, "Item", newItemData, {temporary: true});
        const items = duplicate(targetActor.actor.data.items).concat(created instanceof Array ? created : [created]);
        await targetActor.token.update({"actorData.items": items}, {});
        addedItem = targetActor.getOwnedItem(created.id);
    } else {
        const result = await targetActor.createOwnedItem(newItemData);
        addedItem = targetActor.getOwnedItem(result.id);
    }

    if (desiredParent) {
        let newContents = duplicate(desiredParent.data.data.container.contents || []);
        newContents.push({id: addedItem.id, index: targetItemStorageIndex || 0});
        await targetActor.updateOwnedItem({"id": desiredParent.id, "data.container.contents": newContents});
    }

    return addedItem;
}

/**
 * Removes the specified quantity of a given item from an actor.
 * 
 * @param {ActorItemHelper} sourceActor Actor that owns the item.
 * @param {Item} item Item to remove.
 * @param {Number} quantity Number of items to remove, if quantity is greater than or equal to the item quantity, the item will be removed from the actor.
 * @param {Boolean} recursive (Optional) Recursively remove child items too? Setting this to false puts all items into the deleted item's root. Defaults to false.
 * @returns {Boolean} Returns whether or not an update or removal took place.
 */
export async function removeItemFromActorAsync(sourceActor, itemToRemove, quantity, recursive = false) {
    if (!ActorItemHelper.IsValidHelper(sourceActor) || !itemToRemove) return false;

    const sourceItemQuantity = itemToRemove.data.data.quantity;
    const newItemQuantity = sourceItemQuantity - quantity;

    if (newItemQuantity < 1) {
        return sourceActor.deleteOwnedItem(itemToRemove);
    } else {
        const update = { 'id': itemToRemove.id, 'data.quantity': newItemQuantity };
        return sourceActor.updateOwnedItem(update);
    }
}

/**
 * Moves an item from one actor to another, adjusting its container settings appropriately.
 * 
 * @param {ActorItemHelper} sourceActor The source actor.
 * @param {Item} itemToMove Item to be moved.
 * @param {ActorItemHelper} targetActor The target actor.
 * @param {Item} targetItem (Optional) Item to add the item to, merge with, or make sibling for.
 * @param {Number} quantity (Optional) Amount of item to move, if null will move everything.
 * @returns {Item} Returns the item on the targetActor.
 */
export async function moveItemBetweenActorsAsync(sourceActor, itemToMove, targetActor, targetItem = null, quantity = null, targetItemStorageIndex = null) {
    if (!ActorItemHelper.IsValidHelper(targetActor)) {
        console.log("Inventory::moveItemBetweenActorsAsync: targetActor is not a valid ActorItemHelper instance.");
        return null;
    }

    if (!itemToMove) {
        console.log("Inventory::moveItemBetweenActorsAsync: itemToMove is not valid.");
        return null;
    }

    if (!ActorItemHelper.IsValidHelper(sourceActor)) {
        console.log("Inventory::moveItemBetweenActorsAsync: sourceActor is not a valid ActorItemHelper, switching to addItemToActorAsync.");
        return addItemToActorAsync(targetActor, itemToMove, itemToMove.data.data.quantity, targetItem, targetItemStorageIndex);
    }

    const itemQuantity = itemToMove.data?.data?.quantity;
    if (!quantity) {
        quantity = itemQuantity;

        if (acceptsItem(targetItem, itemToMove, targetActor)) {
            const storageIndex = getFirstAcceptableStorageIndex(targetItem, itemToMove);
            if (storageIndex !== null) {
                const storage = targetItem.data.data.container.storage[storageIndex];
                if (storage.type === "slot") {
                    quantity = 1;
                }
            }
        }
    }

    const isFullMove = (quantity >= itemQuantity);

    if (sourceActor.actor === targetActor.actor) {
        if (quantity < itemQuantity) {
            let updateOld = { id: itemToMove.id, "data.quantity": itemQuantity - quantity };
            await sourceActor.updateOwnedItem(updateOld);

            let newItemData = duplicate(itemToMove.data);
            delete newItemData.id;
            newItemData.data.quantity = quantity;
            
            itemToMove = await targetActor.createOwnedItem(newItemData);
            itemToMove = targetActor.getOwnedItem(itemToMove[0].id);
        }

        if (itemToMove === targetItem) {
            return itemToMove;
        }

        let desiredParent = null;
        let desiredStorageIndex = null;
        if (targetItem) {
            if (acceptsItem(targetItem, itemToMove, targetActor)) {
                desiredParent = targetItem;
                desiredStorageIndex = targetItemStorageIndex;
            } else if (canMerge(targetItem, itemToMove)) {
                // Merging will destroy the old item, so we return the targetItem here.
                const targetItemNewQuantity = Number(targetItem.data.data.quantity) + Number(quantity);
                const update = { 'id': targetItem.id, 'data.quantity': targetItemNewQuantity};
                await targetActor.updateOwnedItem(update);

                if (quantity >= itemQuantity) {
                    await sourceActor.deleteOwnedItem(itemToMove.id);
                } else {
                    const updateOld = { 'id': itemToMove.id, 'data.quantity': itemQuantity - quantity};
                    await sourceActor.updateOwnedItem(updateOld);
                }

                return targetItem;
            } else {
                let targetsParent = targetActor.findItem(x => x.data.data.container?.contents && x.data.data.container.contents.find( y => y.id === targetItem.id));
                if (targetsParent) {
                    if (!wouldCreateParentCycle(itemToMove, targetsParent, targetActor)) {
                        desiredParent = targetsParent;
                        desiredStorageIndex = getFirstAcceptableStorageIndex(desiredParent, itemToMove);
                    } else {
                        return itemToMove;
                    }
                }
            }
        }

        let currentParent = targetActor.findItem(x => x.data.data.container?.contents && x.data.data.container.contents.find(y => y.id === itemToMove.id));

        if (desiredParent !== currentParent) {
            let bulkUpdates = [];
            if (currentParent) {
                let newContents = currentParent.data.data.container.contents.filter(x => x.id !== itemToMove.id);
                bulkUpdates.push({id: currentParent.id, "data.container.contents": newContents});
            }

            if (desiredParent) {
                let newContents = duplicate(desiredParent.data.data.container?.contents || []);
                newContents.push({id: itemToMove.id, index: desiredStorageIndex || 0});
                bulkUpdates.push({id: desiredParent.id, "data.container.contents": newContents});
            }

            if (itemToMove.data.data.equipped) {
                bulkUpdates.push({id: itemToMove.id, "data.equipped": false});
            }

            await targetActor.updateOwnedItem(bulkUpdates);
        }

        return itemToMove;
    } else {
        /** Get all items to move. */
        const items = [];
        const itemsToMove = [{item: itemToMove, parent: null}];
        while (itemsToMove.length > 0) {
            const itemToCreate = itemsToMove.shift();
            const contents = getChildItems(sourceActor, itemToCreate.item);
            if (contents) {
                for (const contentItem of contents) {
                    itemsToMove.push({item: contentItem, parent: itemToCreate});
                }
            }

            const duplicatedData = duplicate(itemToCreate.item);
            if (duplicatedData.data.equipped) {
                duplicatedData.data.equipped = false;
            }
            
            items.push({item: duplicatedData, children: contents, parent: itemToCreate.parent});
        }

        if (targetItem) {
            if (canMerge(targetItem, itemToMove)) {
                const updateResult = await targetActor.updateOwnedItem({ id: targetItem.id, 'data.quantity': parseInt(targetItem.data.data.quantity) + parseInt(quantity)});
                
                if (isFullMove) {
                    const itemsToRemove = items.map(x => x.item.id);
                    await sourceActor.deleteOwnedItem(itemsToRemove);
                } else {
                    await sourceActor.updateOwnedItem({id: itemToMove.id, 'data.quantity': itemQuantity - quantity});
                }

                return updateResult;
            }
        }

        /** Add new items to target actor. */
        const itemData = items.map(x => x.item);
        if (targetActor.actor?.sheet) {
            targetActor.actor.sheet.stopRendering = true;
        }
        if (targetActor.token?.sheet) {
            targetActor.token.sheet.stopRendering = true;
        }

        /** Ensure the original to-move item has the quantity correct. */
        itemData[0].data.quantity = quantity;

        if (itemData.length != items.length) {
            console.log(['Mismatch in item count', itemData, items]);
            return;
        }

        const createOwnedItemResult = await targetActor.createOwnedItem(itemData);
        const createResult = createOwnedItemResult instanceof Array ? createOwnedItemResult : [createOwnedItemResult];
        if (targetActor.actor?.sheet) {
            targetActor.actor.sheet.stopRendering = false;
        }
        if (targetActor.token?.sheet) {
            targetActor.token.sheet.stopRendering = false;
        }

        if (createResult.length != items.length) {
            console.log(['Mismatch in item count after creating', createResult, items]);
            const deleteIds = createResult.map(x => x.id);
            return targetActor.deleteOwnedItem(deleteIds);
        }

        const updatesToPerform = [];
        for (let i = 0; i<items.length; i++) {
            const itemToTest = items[i];
            const itemToUpdate = createResult[i];

            if (itemToTest.children && itemToTest.children.length > 0) {
                const indexMap = itemToTest.item.data.container.contents.map(x => {
                    const foundItem = items.find(y => y.item.id === x.id);
                    const foundItemIndex = items.indexOf(foundItem);
                    return foundItemIndex;
                });

                let newContents = duplicate(itemToUpdate.data.container.contents);
                for (let j = 0; j<indexMap.length; j++) {
                    const index = indexMap[j];
                    if (index === -1) {
                        newContents[j].id = "deleteme";
                        continue;
                    }

                    try {
                        newContents[j].id = createResult[index].id;
                    } catch (error) {
                        console.log({
                            index: index,
                            items: items,
                            createResult: createResult,
                            itemToTest: itemToTest,
                            itemToUpdate: itemToUpdate,
                            indexMap: indexMap
                        });
                        const deleteIds = createResult.map(x => x.id);
                        await targetActor.deleteOwnedItem(deleteIds);
                        throw error;
                    }
                }

                newContents = newContents.filter(x => x.id !== "deleteme");

                updatesToPerform.push({ id: itemToUpdate.id, 'data.container.contents': newContents});
            }
        }

        let desiredParent = null;
        let desiredStorageIndex = null;
        if (targetItem) {
            if (acceptsItem(targetItem, itemToMove, targetActor)) {
                desiredParent = targetItem;
                desiredStorageIndex = targetItemStorageIndex;
            } else {
                let targetsParent = targetActor.findItem(x => x.data.data.container?.contents && x.data.data.container.contents.find( y => y.id === targetItem.id));
                if (targetsParent) {
                    if (!wouldCreateParentCycle(itemToMove, targetsParent, targetActor)) {
                        desiredParent = targetsParent;
                        desiredStorageIndex = getFirstAcceptableStorageIndex(desiredParent, itemToMove);
                    }
                }
            }
        }

        if (desiredParent) {
            const newContents = duplicate(desiredParent.data.data.container?.contents || []);
            newContents.push({id: createResult[0].id, index: desiredStorageIndex || 0});
            updatesToPerform.push({id: desiredParent.id, "data.container.contents": newContents});
        }

        await targetActor.updateOwnedItem(updatesToPerform);
        if (targetActor.actor?.sheet) {
            targetActor.actor.sheet.render(false);
        }
        if (targetActor.token?.sheet) {
            targetActor.token.sheet.render(false);
        }

        /** Delete all items from source actor. */
        if (isFullMove) {
            const itemsToRemove = items.map(x => x.item.id);
            await sourceActor.deleteOwnedItem(itemsToRemove);
        } else {
            await sourceActor.updateOwnedItem({id: itemToMove.id, 'data.quantity': itemQuantity - quantity});
        }

        return createResult[0];
    }
}

/**
 * Changes the item's container on an actor.
 * 
 * @param {ActorItemHelper} actor 
 * @param {Item} item 
 * @param {Item} container 
 */
export async function setItemContainer(actor, item, container) {
    return await moveItemBetweenActorsAsync(actor, item, actor, container);
}

/**
 * Returns the bulk of the item, along with its contents.
 * To prevent rounding errors, all calculations are done in integer space by multiplying bulk by 10.
 * A bulk of L is considered as 1, while a bulk of 1 would be 10. Any other non-number bulk is considered 0 bulk.
 * 
 * Item container properties such as equipped bulk and content bulk multipliers are taken into account here.
 * 
 * @param {Object} item The item whose bulk is to be calculated.
 * @param {Array} contents An array of items who are considered children of the item.
 * @returns {Number} A multiplied-by-10 value of the total bulk.
 */
export function computeCompoundBulkForItem(item, contents) {
    let contentBulk = 0;
    //console.log(["computeCompoundBulk", item?.name, contents]);
    if (item?.data?.container?.storage && item.data.container.storage.length > 0) {
        for (let storage of item.data.container.storage) {
            let storageIndex = item.data.container.storage.indexOf(storage);
            let storageBulk = 0;

            let storedItems = contents.filter(x => item.data.container.contents.find(y => y.id === x.item.id && y.index === storageIndex));
            if (storage.affectsEncumbrance) {
                for (let child of storedItems) {
                    let childBulk = computeCompoundBulkForItem(child.item, child.contents);
                    storageBulk += childBulk;
                }
            }

            contentBulk += storageBulk;
            //console.log(`${item.name}, storage ${storageIndex}, contentBulk: ${contentBulk}`);
        }
    } else if (contents?.length > 0) {
        for (let child of contents) {
            let childBulk = computeCompoundBulkForItem(child.item, child.contents);
            contentBulk += childBulk;
        }
    }

    let personalBulk = 0;
    if (item?.data?.bulk) {
        if (item.data.bulk.toUpperCase() === "L") {
            personalBulk = 1;
        } else if (!Number.isNaN(Number.parseInt(item.data.bulk))) {
            personalBulk = item.data.bulk * 10;
        }

        if (item.data.quantity && !Number.isNaN(Number.parseInt(item.data.quantity))) {
            personalBulk *= item.data.quantity;
        }

        if (item.data.equipped) {
            if (item.data.equippedBulkMultiplier !== undefined && !Number.isNaN(Number.parseInt(item.data.equippedBulkMultiplier))) {
                personalBulk *= item.data.equippedBulkMultiplier;
            }
        }
    }

    //console.log(`${item?.name || "null"} has a content bulk of ${contentBulk}, and personal bulk of ${personalBulk}`);
    return personalBulk + contentBulk;
}

/**
 * Tests if a given item contains any items.
 * 
 * @param {Item} item Item to test.
 * @returns {Boolean} Boolean whether or not this item contains anything.
 */
export function containsItems(item) {
    return item && item.data.data.container?.contents && item.data.data.container.contents.length > 0;
}

/**
 * Returns an array of child items for a given item on an actor.
 * 
 * @param {Actor} actor Actor for whom's items to test.
 * @param {Item} item Item to get the children of.
 * @returns {Array} An array of child items.
 */
export function getChildItems(actor, item) {
    if (!actor) return [];
    if (!containsItems(item)) return [];
    return actor.filterItems(x => item.data.data.container.contents.find(y => y.id === x.id));
}

export function getItemContainer(items, itemId) {
    return items.find(x => x.data.container?.contents?.find(y => y.id === itemId) !== undefined);
}

/**
 * Checks if two given items can be merged.
 * @param {Item} itemA 
 * @param {Item} itemB 
 */
function canMerge(itemA, itemB) {
    if (!itemA || !itemB) {
        console.log(`Can't merge because of null-items: itemA: ${itemA}, itemB: ${itemB}`)
        return false;
    }
    if (itemA.name !== itemB.name || itemA.type !== itemB.type) {
        console.log(`Can't merge because of name or type mismatch: itemA: ${itemA.type}/${itemA.name}, itemB: ${itemB.type}/${itemB.name}`);
        return false;
    }

    // Containers cannot merge, otherwise you can have multiple containers containing the same items multiple times, etc.
    if (itemA.type === "container" || itemB.type === "container") {
        console.log(`Can't merge because one or both items are a container: itemA: ${itemA.type}/${itemA.name}, itemB: ${itemB.type}/${itemB.name}`);
        return false;
    }

    // If items contain other items, they cannot merge. This can be the case for non-containers like armors with armor upgrades, etc.
    const itemAContainsItems = containsItems(itemA);
    const itemBContainsItems = containsItems(itemB);
    if (itemAContainsItems || itemBContainsItems) {
        console.log(`Can't merge because one or both items contain items: itemA: ${itemAContainsItems}, itemB: ${itemBContainsItems}`);
        return false;
    }

    // Perform deep comparison on item data.
    let itemDataA = duplicate(itemA.data.data);
    delete itemDataA.quantity;

    let itemDataB = duplicate(itemB.data.data);
    delete itemDataB.quantity;

    // TODO: Remove all keys that are not template appropriate given the item type, remove all keys that are not shared?

    const deepEqual = value_equals(itemDataA, itemDataB, false, true);
    return deepEqual;
}

export function getFirstAcceptableStorageIndex(container, itemToAdd) {
    let index = -1;
    if (!(container.type in SFRPG.containableTypes)) {
        return null;
    }

    for (let storageOption of container.data.data.container.storage) {
        index += 1;
        if (storageOption.amount == 0) {
            //console.log(`Skipping storage ${index} because it has a 0 amount.`);
            continue;
        }

        if (!storageOption.acceptsType.includes(itemToAdd.type)) {
            //console.log(`Skipping storage ${index} because it doesn't accept ${itemToAdd.type}.`);
            continue;
        }

        if (storageOption.weightProperty && !itemToAdd.data.data[storageOption.weightProperty]) {
            //console.log(`Skipping storage ${index} because it does not match the weight settings.`);
            continue;
        }

        if (storageOption.type === "slot") {
            const storedItemLinks = container.data.data.container.contents.filter(x => x.index === index);

            if (storageOption.weightProperty === "items") {
                const numItemsInStorage = storedItemLinks.length;
                if (numItemsInStorage >= storageOption.amount) {
                    //console.log(`Skipping storage ${index} because it has too many items in the slots already. (${numItemsInStorage} / ${storageOption.amount})`);
                    continue;
                }
            } else {
                const storedItems = storedItemLinks.map(x => container.actor?.getOwnedItem(x.id));
                const totalStoredAmount = storedItems.reduce((accumulator, currentValue, currentIndex, array) => {
                    return accumulator + currentValue.data.data[storageOption.weightProperty];
                }, itemToAdd.data.data[storageOption.weightProperty]);

                if (totalStoredAmount > storageOption.amount) {
                    //console.log(`Skipping storage ${index} because it has too many items in the slots already. (${totalStoredAmount} / ${storageOption.amount})`);
                    continue;
                }
            }
        }

        return index;
    }

    return null;
}

function acceptsItem(containerItem, itemToAdd, actor) {
    if (!containerItem || !itemToAdd) {
        //console.log("Rejected because container or item is null");
        return false;
    }

    if (!(itemToAdd.type in SFRPG.containableTypes)) {
        //console.log("Rejected because item is not a containable item: " + itemToAdd.type);
        return false;
    }

    if (!containerItem.data.data.container) {
        console.log("Rejected because target is not a container");
        return false;
    }

    if (containerItem.data.data.quantity > 1) {
        console.log("Rejected because only items with a quantity of 1 can contain items.");
        return false;
    }

    let storageFound = getFirstAcceptableStorageIndex(containerItem, itemToAdd);
    if (storageFound === null) {
        console.log("Rejected because no suitable storage found");
        return false;
    }

    if (wouldCreateParentCycle(itemToAdd, containerItem, actor)) {
        //console.log("Rejected because adding this item would create a cycle");
        return false;
    }

    return true;
}

/**
 * Checks if assigning the itemId as a child to the container would create a cycle.
 * This can happen if the container is contained within item.
 */
function wouldCreateParentCycle(item, container, actor) {
    if (!item) throw "Inventory::wouldCreateParentCycle: No item specified.";
    if (!container) throw "Inventory::wouldCreateParentCycle: No container specified.";
    if (!actor) throw "Inventory::wouldCreateParentCycle: No actor specified.";
    if (item === container) return true;

    // If the item has no children it cannot create cycles.
    if (!containsItems(item)) return false;

    if (item.data.data.container.contents.find(y => y.id === container.id)) return true;

    let itemsToTest = duplicate(item.data.data.container.contents || []);
    while (itemsToTest.length > 0) {
        let content = itemsToTest.shift();
        let child = actor.getOwnedItem(content.id);
        if (!child) continue;

        if (!containsItems(child)) continue;
        if (child.data.data.container.contents.find(y => y.id === container.id)) return true;
        itemsToTest = itemsToTest.concat(child.data.data.container.contents);
    }
    return false;
}

/******************************************************************************
 * RPC handlers
 ******************************************************************************/
export async function onCreateItemCollection(message) {
    let payload = message.payload;
    if (!payload.itemData) {
        return false;
    }

    return Token.create({
        name: payload.itemData[0].name,
        x: payload.position.x,
        y: payload.position.y,
        img: payload.itemData[0].img,
        hidden: false,
        locked: true,
        disposition: 0,
        flags: {
            "sfrpg": {
                "itemCollection": {
                    items: payload.itemData,
                    locked: payload.settings.locked,
                    deleteIfEmpty: payload.settings.deleteIfEmpty
                }
            }
        }
    });
}

async function onItemDraggedToCollection(message) {
    let data = message.payload;

    let target = ActorItemHelper.FromObject(data.target);
    let items = target.token.data.flags.sfrpg.itemCollection.items;

    let targetContainer = null;
    if (data.containerId) {
        targetContainer = items.find(x => x.id === data.containerId);
    }

    let newItems = [];
    if (data.pack) {
        const pack = game.packs.get(data.pack);
        const itemData = await pack.getEntry(data.draggedItemId);
        itemData.id = randomID(16);
        newItems.push(duplicate(itemData));
    } else if (data.source.tokenId || data.source.actorId) {
        // from another token
        let source = ActorItemHelper.FromObject(data.source);
        if (!source.isValid()) {
            return;
        }

        newItems.push(data.draggedItemData);
        await source.deleteOwnedItem(data.draggedItemData.id);
    } else {
        let sidebarItem = game.items.get(data.draggedItemId);
        if (sidebarItem) {
            let itemData = duplicate(sidebarItem.data);
            itemData.id = randomID(16);
            newItems.push(duplicate(itemData));
        }
    }

    if (newItems.length > 0) {
        if (targetContainer && targetContainer.data.container?.contents) {
            for (let newItem of newItems) {
                let preferredStorageIndex = getFirstAcceptableStorageIndex(targetContainer, newItem) || 0;
                targetContainer.data.container.contents.push({id: newItem.id, index: preferredStorageIndex});
            }
        }
        newItems = items.concat(newItems);
        const update = {
            "flags.sfrpg.itemCollection.items": newItems
        }
        await target.token.update(update);
    }
}

async function onItemCollectionItemDraggedToPlayer(message) {
    const data = message.payload;

    // Unpack data
    const source = ActorItemHelper.FromObject(data.source);
    const target = ActorItemHelper.FromObject(data.target);

    if (!source.token) {
        RPC.sendMessageTo(message.sender, "raiseInventoryWarning", "SFRPG.ActorSheet.Inventory.Interface.DragFromExternalTokenError");
        return;
    }

    if (!target.actor) {
        RPC.sendMessageTo(message.sender, "raiseInventoryWarning", "SFRPG.ActorSheet.Inventory.Interface.NoTarget");
        return;
    }

    let targetContainer = null;
    if (data.containerId) {
        targetContainer = target.getOwnedItem(data.containerId);
    }

    // Add items to target
    let uncontainedItemIds = [];
    const copiedItemIds = [];
    const itemToItemMapping = {};

    const creationResult = await target.createOwnedItem(data.draggedItems);
    const createdItems = creationResult instanceof Array ? creationResult : [creationResult];
    for (let i = 0; i<createdItems.length; i++) {
        const newItem = createdItems[i];
        const originalItem = data.draggedItems[i];

        itemToItemMapping[originalItem.id] = newItem;
        copiedItemIds.push(originalItem.id);
        uncontainedItemIds.push(newItem.id);
    }

    const bulkUpdates = [];
    for (const originalItem of data.draggedItems) {
        const newItem = itemToItemMapping[originalItem.id];
        if (originalItem.data.container?.contents && originalItem.data.container.contents.length > 0) {
            let newContents = [];
            for (const originalContent of originalItem.data.container.contents) {
                const originalContentItem = data.draggedItems.find(x => x.id === originalContent.id);
                const newContentItem = itemToItemMapping[originalContentItem.id];
                newContents.push({id: newContentItem.id, index: originalContent.index});
                uncontainedItemIds = uncontainedItemIds.filter(x => x !== newContentItem.id);
            }

            const update = {id: newItem.id, "data.container.contents": newContents};
            bulkUpdates.push(update);
        }
    }
    if (bulkUpdates.length > 0) {
        await target.updateOwnedItem(bulkUpdates);
    }

    // Remove items from source token
    let sourceItems = duplicate(source.token.data.flags.sfrpg.itemCollection.items);
    sourceItems = sourceItems.filter(x => !copiedItemIds.includes(x.id));
    await source.token.update({"flags.sfrpg.itemCollection.items": sourceItems});

    if (sourceItems.length === 0 && source.token.data.flags.sfrpg.itemCollection.deleteIfEmpty) {
        await source.token.delete();
    }

    // Add any uncontained items into targetItem, if applicable
    if (targetContainer) {
        const acceptableItemIds = [];
        for (let uncontainedItemId of uncontainedItemIds) {
            const uncontainedItem = target.getOwnedItem(uncontainedItemId);
            if (acceptsItem(targetContainer, uncontainedItem, target.actor)) {
                let preferredStorageIndex = getFirstAcceptableStorageIndex(targetContainer, uncontainedItem) || 0;
                acceptableItemIds.push({id: uncontainedItemId, index: preferredStorageIndex});
            }
        }

        if (acceptableItemIds.length > 0) {
            const combinedContents = targetContainer.data.data.container.contents.concat(acceptableItemIds);
            const update = {id: targetContainer.id, "data.container.contents": combinedContents};
            await target.updateOwnedItem(update);
        }
    }
}

async function onInventoryWarningReceived(message) {
    ui.notifications.info(game.i18n.format(message.payload));
}

/******************************************************************************
 * Helper classes
 ******************************************************************************/

 /**
  * A helper class that takes an actor, token, and scene id and neatly wraps the
  * item interfaces so that they go to the right actor data. Unlinked tokens thus
  * remain unlinked from the parent actor, while linked tokens will share with
  * their parent.
  */
export class ActorItemHelper {
    constructor(actorId, tokenId, sceneId) {
        this.actorId = actorId;
        this.tokenId = tokenId;
        this.sceneId = sceneId;

        if (tokenId) {
            this.token = canvas.tokens.placeables.find(x => x.id === tokenId);
            if (!this.token) {
                this.token = game.scenes.get(sceneId).data.tokens.find(x => x.id === tokenId);
            }

            if (this.token) {
                this.scene = this.token.scene || game.scenes.get(sceneId);
                this.actor = this.token.actor;
            }
        }
        
        if (!this.actor && actorId) {
            this.actor = game.actors.get(actorId);
        }

        //console.log([actorId, tokenId, sceneId]);
        //console.log([this.actor, this.token, this.scene]);
    }

    /**
     * Parses a new ActorItemHelper out of an object containing actorId, tokenId, and sceneId.
     * @param {Object} actorReferenceObject 
     */
    static FromObject(actorReferenceObject) {
        return new ActorItemHelper(actorReferenceObject.actorId, actorReferenceObject.tokenId, actorReferenceObject.sceneId);
    }

    toObject() {
        return {actorId: this.actorId, tokenId: this.tokenId, sceneId: this.sceneId};
    }

    static IsValidHelper(object) {
        return (object && object instanceof ActorItemHelper && object.isValid());
    }

    isValid() {
        return (this.actor);
    }

    /**
     * Wrapper around actor.getOwnedItem.
     * @param {String} itemId ID of item to get.
     */
    getOwnedItem(itemId) {
        if (!this.actor) return null;
        return this.actor.items.get(itemId);
    }

    /**
     * Wrapper around actor.createOwnedItem.
     * @param {Object} itemData Data for item to create.
     * @returns An array of newly created items.
     */
    async createOwnedItem(itemData) {
        if (!this.actor) return null;

        let newItem = null;
        if (this.actor.isToken) {
            const created = await Entity.prototype.createEmbeddedEntity.call(this.actor, "Item", itemData, {temporary: true});
            const createResult = created instanceof Array ? created : [created];
            const items = duplicate(this.actor.data.items).concat(createResult);
            await this.actor.token.update({"actorData.items": items}, {});
            newItem = createResult;
        } else {
            const dataToCreate = itemData instanceof Array ? itemData : [itemData];
            const createResult = await this.actor.createEmbeddedDocuments("Item", dataToCreate, {});
            newItem = createResult instanceof Array ? createResult : [createResult];
        }

        return newItem;
    }

    /**
     * Wrapper around actor.updateOwnedItem.
     * @param {Object} update Data to update with. Must have an id field.
     */
    async updateOwnedItem(update) {
        if (!this.actor) return null;
        return this.actor.updateOwnedItem(update);
    }

    /**
     * Wrapper around actor.deleteOwnedItem.
     * @param {String} itemId ID of item to delete.
     * @param {Boolean} recursive (Optional) Set to true to also delete contained items. Defaults to false.
     */
    async deleteOwnedItem(itemId, recursive = false) {
        if (!this.actor) return null;

        let itemsToDelete = (itemId instanceof Array) ? itemId : [itemId];

        if (recursive) {
            let idsToTest = [itemId];
            while (idsToTest.length > 0) {
                let idToTest = idsToTest.shift();
                let item = this.getOwnedItem(idToTest);
                if (item && item.data.data.container?.contents) {
                    for (let containedItem of item.data.data.container.contents) {
                        itemsToDelete.push(containedItem.id);
                        idsToTest.push(containedItem.id);
                    }
                }
            }
        }

        /** Clean up parent container, if deleted from container. */
        const promises = [];
        const container = this.actor.items.find(x => x.data.data?.container?.contents?.find(y => y.id === itemId) !== undefined);
        if (container) {
            const newContents = container.data.data.container.contents.filter(x => x.id !== itemId);
            promises.push(this.actor.updateOwnedItem({"id": container.id, "data.container.contents": newContents}));
        }

        promises.push(this.actor.deleteEmbeddedDocuments("Item", itemsToDelete, {}));

        return Promise.all(promises);
    }

    /**
     * Wrapper around actor.items.find().
     * @param {Function} fn Method used to search the item.
     * @returns The first item matching fn. Null if nothing is found or invalid helper.
     */
    findItem(fn) {
        if (!ActorItemHelper.IsValidHelper(this)) {
            return null;
        }
        return this.actor.items.find(fn);
    }

    /**
     * Wrapper around actor.items.filter().
     * @param {*} fn Method used to filter the items.
     * @returns Array of items matching fn. Null if invalid helper.
     */
    filterItems(fn) {
        if (!ActorItemHelper.IsValidHelper(this)) {
            return null;
        }
        return this.actor.items.filter(fn);
    }

    /**
     * Function that migrates actor items to the new data format, using some rough guesstimations.
     */
    async migrateItems() {
        if (!this.isValid()) return;

        const propertiesToTest = ["contents", "storageCapacity", "contentBulkMultiplier", "acceptedItemTypes", "fusions", "armor.upgradeSlots", "armor.upgrades"];
        for (const item of this.actor.items) {
            const itemData = duplicate(item.data.data);
            let isDirty = false;

            // Migrate original format
            let migrate = propertiesToTest.filter(x => itemData.hasOwnProperty(x));
            if (migrate.length > 0) {
                //console.log(migrate);

                let container = {
                    contents: (itemData.contents || []).map(x => { return { id: x, index: 0 }; }),
                    storage: []
                };

                if (item.type === "container") {
                    container.storage.push({
                        type: "bulk",
                        subtype: "",
                        amount: itemData.storageCapacity || 0,
                        acceptsType: itemData.acceptedItemTypes ? Object.keys(itemData.acceptedItemTypes) : [],
                        affectsEncumbrance: itemData.contentBulkMultiplier === 0 ? false : true,
                        weightProperty: "bulk"
                    });
                } else if (item.type === "weapon") {
                    container.storage.push({
                        type: "slot",
                        subtype: "fusion",
                        amount: itemData.level,
                        acceptsType: ["fusion"],
                        affectsEncumbrance: false,
                        weightProperty: "level"
                    });
                } else if (item.type === "equipment") {
                    container.storage.push({
                        type: "slot",
                        subtype: "armorUpgrade",
                        amount: itemData.armor?.upgradeSlots || 0,
                        acceptsType: ["upgrade", "weapon"],
                        affectsEncumbrance: true,
                        weightProperty: "slots"
                    });
                    container.storage.push({
                        type: "slot",
                        subtype: "weaponSlot",
                        amount: itemData.weaponSlots || 0,
                        acceptsType: ["weapon"],
                        affectsEncumbrance: true,
                        weightProperty: "slots"
                    });
                }

                itemData["container"] = container;

                delete itemData.contents;
                delete itemData.storageCapacity;
                delete itemData.acceptedItemTypes;
                delete itemData.contentBulkMultiplier;

                delete itemData.containedItemIds;
                delete itemData.fusions;
                if (itemData.armor) {
                    delete itemData.armor.upgradeSlots;
                    delete itemData.armor.upgrades;
                }
            }

            // Migrate intermediate format
            if (itemData.container?.contents?.length > 0) {
                let isDirty = false;
                if (itemData.container.contents[0] instanceof String) {
                    for (let i = 0; i<itemData.container.contents.length; i++) {
                        itemData.container.contents[i] = {id: itemData.container.contents[0], index: 0};
                    }

                    isDirty = true;
                }

                if (itemData.container.itemWeightMultiplier) {
                    delete itemData.container.itemWeightMultiplier;
                    isDirty = true;
                }
            }

            if (itemData.container?.storage && itemData.container.storage.length > 0) {
                for (let storage of itemData.container.storage) {
                    if (storage.hasOwnProperty("weightMultiplier")) {
                        storage["affectsEncumbrance"] = storage.weightMultiplier === 0 ? false : true;
                        delete storage.weightMultiplier;
                        isDirty = true;
                    }
                }
            }

            /** Ensure deleted items are cleaned up. */
            const newContents = itemData.container?.contents?.filter(x => this.actor.items.find(ownedItem => ownedItem.id === x.id));
            if (newContents?.length !== itemData.container?.contents?.length) {
                //console.log([`Actor ${this.actor.name} has deleted item(s) for ${item.name}`, item, itemData.container.contents, newContents]);
                itemData.container.contents = newContents;
                isDirty = true;
            }

            if (isDirty) {
                console.log("> Migrating " + item.name);
                await this.actor.updateEmbeddedDocuments("Item", [{ id: item.id, data: itemData}]);
            }
        }
    }
}