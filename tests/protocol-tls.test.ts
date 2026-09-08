import { describe, expect, it } from "vitest";
import tls from "node:tls";
import type net from "node:net";
import { AxisTransport } from "../src/main/protocol/transport";
import { decode, encode, i32, str, string } from "../src/main/protocol/codec";
import { P, V } from "../src/main/protocol/constants";

// Public, throwaway localhost test certificate/key. This is not a deployment
// identity and is never installed into the OS trust store (valid 2026–2036).
const key =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC3BC0+31k5+ZyF\nDWLnr0re2PhObGQmxgs6MQh5TO5Rg7U85+juEnztMlI1RiYjKlrtCrwIP5jTEWTN\nKNJMYkayB0zN81XSIh0CPAKFbCLlnVSlm798x40V4yHwbFsr7qZp6T+M97gW9OVZ\nF95Ar+JXHHnFSgQ3ZK5XC4DU/Edk5svL8/LSXnqe15n49pYcr+SwqdfWhEJjN5z1\nwvnbRuU7tL+Rs93nk4fjU8S4ETC/+Bv0gpepvU2fcSrLT1hUZKwiIMDHP6xpaoTy\n3oPj5eVChO0OxndvfcXeikipYK0bWJmkSyQsesbsRucmgKyroGKMVpm2CryvDGdX\nzfM96Oa5AgMBAAECggEAazThJDFFXTagvzfmNf1zCDNk0NuhlyzvqrjKU/QCrnFO\nm0zmH39o+rE9gsOC15qaBL0DBHnslcdcmulMtz3iV6r7DLF8FkmxYHuypmF/161f\nxlsDwp5KQQX5/ZIbnhKAHQ5rEbKSfbAbISNgJ9hf59NgaXdAHQq3LXopj5nwYGPs\nTWUbso42z4fS6BCqeIFr1ZhQ2WaN1ZWWNS6k10SvNd7qk/PkpVcfHrdQmjrFXBVf\nMYhDUpV38sfm8Z7WCx7FHFJy4kzkwIzusEBtrcWCfPXu9YYvBIOWSLE0oY4b+AQX\nCkhms6bJwvpKc6fuxxazZZ8pyQPie8MjrWlXo2wqeQKBgQDfBqXVt56UXxPulodA\nNOyUGYzuJXnyoHgbS9CEC+l/Jjj2aQRhQVfHJbWI3AUcOcaR6WPVfITJ06oUVZzr\nKfT8Z82QEDzKZILZ1K3d1QtmgPEXEOVVFDCNskWSqiIQxU5BtoNMtg01FnhN83F9\nCDxOMQhlHjUZC0GrwQVbH/DR1wKBgQDSEzIt25ZK9P50h+1x4M1GbyelYeCBerux\njRt1FyWN6tF4xa7o0OLVVXRqBXLld1usznRjcI2SzFonj4uQsf/efiOOd7dc5RXf\nSJtiMvLEMqF64NZrz6XdJbky+J/kfMUlI8j7Z6rlbo2ZQM6X0Y2YAIt3IRX3SmXX\n8+T0YEEZ7wKBgH2BMDFkc0jreDv7WYE4RynQdw5M6KMwymYR8/Va/rset09zKZPR\nQaRABDhQGFAZ8zSJMjUhLVimVD+9LeDoa4TepT884/jBNyF+HZmIGjJEvWdNisCl\n6+zRNXWjaCgn4DH6k0jH6gbF7k1vgZ3q1ITr8t10ckz1mK8en/T3tH1hAoGAdQ2X\nJzA0tT1/zySyLILrPnTPLXq1ItBlZxBOHVcxaLtPzrCvvjAuRFqiTDUPCUcRgN9k\nwMfFSues0GBOjuhvvuSgIVEZjZxkLI8DbZsf5CymB5biQx5nuCq93+XjCehv3Trs\nURE5iy+nnJ4cv0FXWTvseguodqswxjyy9WvwumcCgYEA3Qcm6O6sBixspaBlln+F\nFQrVrX/EzRQb8MiVqkjVU/xNhfrs5xsUTXuevOry/qoLmMHTx9f48ZQM41S/rbSS\nEEZ4jaERAd87kevRStIg8GwyHGJ6w4qHtbYAa30MWFtjXmhLsiHLE4PivqNY0+JN\nywGO1Hp5C3A01906toRNH+I=\n-----END PRIVATE KEY-----\n";
const cert =
  "-----BEGIN CERTIFICATE-----\nMIIC1jCCAb6gAwIBAgIJAK5N7IeIS02jMA0GCSqGSIb3DQEBCwUAMCAxHjAcBgNV\nBAMMFVdheWZhcmVyIHRlc3QgZml4dHVyZTAeFw0yNjA5MDcwNDUxNTVaFw0zNjA5\nMDQwNDUxNTVaMCAxHjAcBgNVBAMMFVdheWZhcmVyIHRlc3QgZml4dHVyZTCCASIw\nDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALcELT7fWTn5nIUNYuevSt7Y+E5s\nZCbGCzoxCHlM7lGDtTzn6O4SfO0yUjVGJiMqWu0KvAg/mNMRZM0o0kxiRrIHTM3z\nVdIiHQI8AoVsIuWdVKWbv3zHjRXjIfBsWyvupmnpP4z3uBb05VkX3kCv4lccecVK\nBDdkrlcLgNT8R2Tmy8vz8tJeep7Xmfj2lhyv5LCp19aEQmM3nPXC+dtG5Tu0v5Gz\n3eeTh+NTxLgRML/4G/SCl6m9TZ9xKstPWFRkrCIgwMc/rGlqhPLeg+Pl5UKE7Q7G\nd299xd6KSKlgrRtYmaRLJCx6xuxG5yaArKugYoxWmbYKvK8MZ1fN8z3o5rkCAwEA\nAaMTMBEwDwYDVR0RBAgwBocEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAdIlHWSav\nSu/7V5qv/wAhLr1LSUhFltk1EkbyCrcRWVuY5yk7IJksiz+WXtgxrW1p0lWqEZYL\nPvxfG3ZldZy4Bz/JitZCpK2BlRyZngYqH2AiBumQOscLH6t+X0utyRzwK3ZPZC+w\nXti8rWL12Ps3vwu47BadUD4ObPxk7fkXwtmluEfcpB4PMcM9hrGIOHB0mBU5ObPH\nkcsGXg2km0z+Kf57y8glH8oLcUvy+3nDC6G3Uba1srpuXLsiRPz70NzyKDgCM870\n4/Ng5Mj7VBd/7inRKfBqdsCvobU30s5+qaiwnkne5rSOrUcGHbkHxyQQDI/6UrLq\nrK1MBEPCpgPPuQ==\n-----END CERTIFICATE-----\n";

describe("TLS transport authentication", () => {
  it("rejects an untrusted certificate and accepts an explicitly trusted localhost peer without app-level key exchange", async () => {
    const sockets = new Set<tls.TLSSocket>(),
      received: number[] = [];
    const server = tls.createServer({ key, cert }, (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        for (const p of decode(Buffer.from(chunk))) {
          received.push(p.type);
          socket.write(
            encode(P.WorldListResult, [
              i32(V.ReasonCode, 0),
              str(V.WorldListName, "Trusted TLS Haven"),
            ]),
          );
        }
      });
    });
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as net.AddressInfo).port;
    const bad = new AxisTransport(() => {}),
      good = new AxisTransport(() => {});
    const original = tls.getCACertificates("default");
    try {
      await expect(bad.connect("127.0.0.1", port, true)).rejects.toThrow();
      tls.setDefaultCACertificates([...original, cert]);
      await good.connect("127.0.0.1", port, true);
      const reply = await good.request(P.WorldList, [], P.WorldListResult);
      expect(string(reply, V.WorldListName)).toBe("Trusted TLS Haven");
      expect(received).toEqual([P.WorldList]);
    } finally {
      tls.setDefaultCACertificates(original);
      bad.close();
      good.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
