import type { Address, PendingSignatureRequest, TypedDataPayload } from "@/types/messages";
import { shortenAddress } from "@/lib/format";
import { defaultNetworks } from "@/lib/networks";
import { describeDomain, describeMessage, type RenderedField } from "@/lib/typed-data";

interface Props {
  request: PendingSignatureRequest;
  onApprove(): void;
  onReject(): void;
}

/**
 * The EIP-712 half of the approval window.
 *
 * ---------------------------------------------------------------------------
 * WHY A SIGNATURE DESERVES MORE SCREEN THAN A TRANSFER
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: una firma no cuesta gas, no aparece en el explorador y no mueve nada
 * en el momento de firmarla. Por eso se percibe inofensiva — y por eso es el
 * vector preferido. Un `Permit` firmado da permiso a un tercero para mover tus
 * tokens sin que haya ninguna transacción de por medio: no ves nada raro hasta
 * que los fondos ya no están.
 *
 * Lo que separa firmar un login de firmar una autorización de gasto es el
 * `domain` —sobre todo el `verifyingContract`, que decide DÓNDE vale esa firma—
 * y el `primaryType`, que dice QUÉ es. Por eso el dominio va antes que el
 * mensaje: es lo primero que hay que poder juzgar.
 */
export function TypedDataPrompt({ request, onApprove, onReject }: Props) {
  const [address, payload] = request.params as [Address, TypedDataPayload];
  const network = defaultNetworks().find((entry) => entry.chainId === request.chainId);

  return (
    <main className="approval approval--scroll" data-testid="sign-typed-prompt">
      <header className="approval__header">
        <p className="approval__eyebrow">A site wants you to sign a message</p>
        <p className="approval__origin" data-testid="sign-origin">
          {request.origin}
        </p>
      </header>

      <div className="approval__scroll">
        <dl className="detail-list">
          <div className="detail-row">
            <dt>Signing as</dt>
            <dd className="mono" data-testid="sign-account" title={address}>
              {shortenAddress(address)}
            </dd>
          </div>
          <div className="detail-row">
            <dt>Network</dt>
            <dd data-testid="sign-network">{network?.name ?? request.chainId}</dd>
          </div>
        </dl>

        {/*
          🇪🇸 NOTA: el dominio ANTES que el mensaje. El `verifyingContract` es el
          que determina qué contrato aceptará esta firma — es la diferencia entre
          un login y un permiso de gasto — y enterrarlo debajo del mensaje sería
          poner lo decorativo por delante de lo que decide.
        */}
        <section className="typed-block" data-testid="sign-domain">
          <h2 className="typed-block__title">Domain</h2>
          <dl className="detail-list">
            {describeDomain(payload).map((row) => (
              <div className="detail-row" key={row.label}>
                <dt>{row.label}</dt>
                <dd className="mono" data-testid={`sign-domain-${row.label}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="typed-block" data-testid="sign-message">
          <h2 className="typed-block__title">
            {payload.primaryType}
            <span className="typed-block__type"> · primaryType</span>
          </h2>
          <FieldList fields={describeMessage(payload)} />
        </section>
      </div>

      {/*
        🇪🇸 NOTA: la barra de acciones va FUERA del bloque que scrollea. Un
        `message` muy anidado empujaría los botones fuera de la ventana, y una
        pantalla de firma en la que no se ve el botón de rechazar es una pantalla
        que solo deja aprobar.
      */}
      <div className="approval__actions">
        <button type="button" className="button--ghost" data-testid="sign-reject" onClick={onReject}>
          Reject
        </button>
        <button
          type="button"
          className="button--primary"
          data-testid="sign-approve"
          onClick={onApprove}
        >
          Sign
        </button>
      </div>
    </main>
  );
}

function FieldList({ fields }: { fields: RenderedField[] }) {
  return (
    <ul className="typed-fields">
      {fields.map((field, index) => (
        <li key={`${field.label}-${index}`}>
          {field.children === undefined ? (
            <div className="typed-field">
              <span className="typed-field__label">
                {field.label}
                {field.type.length > 0 && <span className="typed-field__type"> {field.type}</span>}
              </span>
              <span className="typed-field__value mono">
                {field.value}
                {field.truncated === true && (
                  <span className="typed-field__type"> · nested too deep to expand</span>
                )}
              </span>
            </div>
          ) : (
            <div className="typed-field typed-field--group">
              <span className="typed-field__label">
                {field.label}
                <span className="typed-field__type"> {field.type}</span>
              </span>
              <FieldList fields={field.children} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
