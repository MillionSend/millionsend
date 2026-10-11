import { isIP } from "node:net";

/**
 * The smallest MaxMind DB writer the IP geolocation tests need: an IPv6
 * search tree with 32-bit records (IPv4 networks under ::/96, where DB-IP
 * keeps them) and records made of maps, strings and unsigned integers.
 * Nested networks are not supported.
 */
type Value = string | number | { [key: string]: Value };
type Child = { node: number } | { data: number } | null;

function control(type: number, size: number): number[] {
  const [sizeBits, extra] =
    size < 29
      ? [size, []]
      : size < 285
        ? [29, [size - 29]]
        : [30, [(size - 285) >> 8, (size - 285) & 0xff]];
  return type <= 7 ? [(type << 5) | sizeBits, ...extra] : [sizeBits, type - 7, ...extra];
}

function encode(value: Value): Buffer {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from(control(2, bytes.length)), bytes]);
  }
  if (typeof value === "number") {
    const bytes: number[] = [];
    for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
    return Buffer.from([...control(6, bytes.length), ...bytes]);
  }
  const entries = Object.entries(value);
  return Buffer.concat([
    Buffer.from(control(7, entries.length)),
    ...entries.flatMap(([key, item]) => [encode(key), encode(item)]),
  ]);
}

function addressBits(address: string): number[] {
  let bytes: number[];
  if (isIP(address) === 4) {
    bytes = [...new Array<number>(12).fill(0), ...address.split(".").map(Number)];
  } else {
    const [head = "", tail = ""] = address.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = [
      ...left,
      ...new Array<string>(8 - left.length - right.length).fill("0"),
      ...right,
    ];
    bytes = groups.flatMap((group) => {
      const word = Number.parseInt(group, 16);
      return [word >> 8, word & 0xff];
    });
  }
  return bytes.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (byte >> shift) & 1));
}

export function writeMmdb(databaseType: string, networks: [cidr: string, record: Value][]): Buffer {
  const nodes: [Child, Child][] = [[null, null]];
  const data: Buffer[] = [];
  let dataSize = 0;
  for (const [cidr, record] of networks) {
    const [address = "", length = "0"] = cidr.split("/");
    const prefix = (isIP(address) === 4 ? 96 : 0) + Number(length);
    const bits = addressBits(address);
    const encoded = encode(record);
    const offset = dataSize;
    data.push(encoded);
    dataSize += encoded.length;
    let node = 0;
    for (let depth = 0; depth < prefix; depth++) {
      const bit = bits[depth] as 0 | 1;
      const current = nodes[node] as [Child, Child];
      if (depth === prefix - 1) {
        current[bit] = { data: offset };
        break;
      }
      const child = current[bit];
      if (child && "node" in child) {
        node = child.node;
      } else {
        nodes.push([null, null]);
        current[bit] = { node: nodes.length - 1 };
        node = nodes.length - 1;
      }
    }
  }
  const count = nodes.length;
  const record = (child: Child) =>
    child === null ? count : "node" in child ? child.node : count + 16 + child.data;
  const tree = Buffer.alloc(count * 8);
  nodes.forEach(([left, right], i) => {
    tree.writeUInt32BE(record(left), i * 8);
    tree.writeUInt32BE(record(right), i * 8 + 4);
  });
  const metadata = encode({
    node_count: count,
    record_size: 32,
    ip_version: 6,
    database_type: databaseType,
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
  });
  return Buffer.concat([
    tree,
    Buffer.alloc(16),
    ...data,
    Buffer.from("abcdef4d61784d696e642e636f6d", "hex"),
    metadata,
  ]);
}
