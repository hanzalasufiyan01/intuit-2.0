import type { Transaction } from '../database/client.js';
import { publishPublicEvent, type PublicEventInput } from '../modules/public-events/index.js';
import type { AppDependencies } from './dependencies.js';

/**
 * The additive emit hook of ADR 0011 section 18.9, passed to services as an optional trailing
 * constructor parameter (like InventoryHooks). `emit` must be called inside the transaction that
 * commits the change, after the change itself succeeded; it only inserts an outbox row.
 */
export interface PublicEventEmitter {
  emit(tx: Transaction, event: PublicEventInput): Promise<void>;
}

export class PublicEventPublisher implements PublicEventEmitter {
  constructor(private readonly deps: AppDependencies) {}

  async emit(tx: Transaction, event: PublicEventInput): Promise<void> {
    await publishPublicEvent(tx, event, this.deps.clock.now());
  }
}
