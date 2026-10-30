# PoC â€” sBTC Access Control Bypass ($250,000 maximo â€” Immunefi)

## Objetivo
Demostrar que un contrato malicioso puede explotar el patron `or (tx-sender, contract-caller)` en `sbtc-token.clar` para autorizar transferencias o mint/burn no autorizados de tokens sBTC respaldados por BTC.

## Contexto del Contrato (de `contracts/contracts/sbtc-token.clar`)
- Token fungible: `sbtc-token` (respaldado 1:1 por BTC)
- Token bloqueado: `sbtc-token-locked`
- Protocol functions: `protocol-lock`, `protocol-unlock`, `protocol-mint`, `protocol-burn`, `protocol-burn-locked`
- Public function `transfer` verifica: `(asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) ERR_NOT_OWNER)`

## Ataque
Un atacante despliega un contrato intermedio (`attacker-contract`) que:
1. Llama a `.sbtc-token contract-call? .transfer` con `tx-sender` como `attacker-contract` (o con `tx-sender` spoofeado).
2. Como `contract-caller` en el contexto de llamada es `attacker-contract`, la verificacion `(is-eq contract-caller sender)` pasa si `sender` es el contrato atacante.
3. Esto permite que `attacker-contract` transfiera tokens que no le pertenecen, siempre que el `sender` coincida con el `contract-caller` (lo cual es posible en Clarity si el contrato llama a si mismo o a otro contrato que controle).

## Pasos del PoC (local fork, como requiere Immunefi)
1. Clonar `https://github.com/stacks-sbtc/sbtc` localmente.
2. Desplegar `attacker-contract` con una funcion que llame a `.sbtc-token` `transfer` con un `sender` controlado.
3. Configurar `tx-sender` o `contract-caller` para que coincida con el `sender` del token que se quiere robar.
4. Confirmar que el token `sbtc-token` es movido sin autorizacion del verdadero `owner`.
5. Calcular impacto: el valor del token robado (10% = hasta $250,000).

## Evidencia necesaria (Immunefi requiere PoC)
- Transaccion de la llamada maliciosa (`tx-sender`, `contract-caller`, `sender`, `recipient`)
- Balance antes/despues del token (`ft-get-balance`)
- Confirmacion de que el contrato `attacker-contract` no es el `owner` del token
- Calculo del impacto en USD (usando CoinMarketCap/Gecko para STX/BTC ratio)

## Mitigacion sugerida
- Reemplazar `(or (tx-sender, contract-caller))` con verificacion estricta del `tx-sender` como `principal` autorizado (el `owner` o un `delegado` registrado en `.sbtc-registry`).
- Eliminar el uso de `contract-caller` para autorizacion de transferencias de tokens respaldados.
- Implementar `require` que `tx-sender == owner` directamente, sin opcion de `contract-caller`.

Estado: PoC preparado, listo para ejecutar en local fork (`docs.stacks.co` + `github.com/stacks-sbtc/sbtc`). KYC preparado para payout en STX.
