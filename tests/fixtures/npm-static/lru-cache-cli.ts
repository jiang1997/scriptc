import { LRUCache } from "lru-cache";

const cache = new LRUCache<string, number>({ max: 2 });
cache.set("a", 1);
cache.set("b", 2);
cache.get("a");
cache.set("c", 3);
console.log([...cache.keys()], cache.has("b"), cache.size);
