import { BlockchainLifecycle } from '@0xproject/dev-utils';
import { assetProxyUtils } from '@0xproject/order-utils';
import { RevertReason, SignedOrder } from '@0xproject/types';
import { BigNumber } from '@0xproject/utils';
import { Web3Wrapper } from '@0xproject/web3-wrapper';
import * as chai from 'chai';
import * as _ from 'lodash';

import { DummyERC20TokenContract } from '../../generated_contract_wrappers/dummy_e_r_c20_token';
import { DummyERC721TokenContract } from '../../generated_contract_wrappers/dummy_e_r_c721_token';
import { ERC20ProxyContract } from '../../generated_contract_wrappers/e_r_c20_proxy';
import { ERC721ProxyContract } from '../../generated_contract_wrappers/e_r_c721_proxy';
import { ExchangeContract } from '../../generated_contract_wrappers/exchange';
import { artifacts } from '../utils/artifacts';
import { expectTransactionFailedAsync } from '../utils/assertions';
import { chaiSetup } from '../utils/chai_setup';
import { constants } from '../utils/constants';
import { ERC20Wrapper } from '../utils/erc20_wrapper';
import { ERC721Wrapper } from '../utils/erc721_wrapper';
import { ExchangeWrapper } from '../utils/exchange_wrapper';
import { OrderFactory } from '../utils/order_factory';
import { ERC20BalancesByOwner } from '../utils/types';
import { provider, txDefaults, web3Wrapper } from '../utils/web3_wrapper';

chaiSetup.configure();
const expect = chai.expect;
const blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);

describe('Exchange wrappers', () => {
    let makerAddress: string;
    let owner: string;
    let takerAddress: string;
    let feeRecipientAddress: string;

    let erc20TokenA: DummyERC20TokenContract;
    let erc20TokenB: DummyERC20TokenContract;
    let zrxToken: DummyERC20TokenContract;
    let erc721Token: DummyERC721TokenContract;
    let exchange: ExchangeContract;
    let erc20Proxy: ERC20ProxyContract;
    let erc721Proxy: ERC721ProxyContract;

    let exchangeWrapper: ExchangeWrapper;
    let erc20Wrapper: ERC20Wrapper;
    let erc721Wrapper: ERC721Wrapper;
    let erc20Balances: ERC20BalancesByOwner;
    let orderFactory: OrderFactory;

    let erc721MakerAssetId: BigNumber;
    let erc721TakerAssetId: BigNumber;

    let defaultMakerAssetAddress: string;
    let defaultTakerAssetAddress: string;

    before(async () => {
        await blockchainLifecycle.startAsync();
    });
    after(async () => {
        await blockchainLifecycle.revertAsync();
    });
    before(async () => {
        const accounts = await web3Wrapper.getAvailableAddressesAsync();
        const usedAddresses = ([owner, makerAddress, takerAddress, feeRecipientAddress] = _.slice(accounts, 0, 4));

        erc20Wrapper = new ERC20Wrapper(provider, usedAddresses, owner);
        erc721Wrapper = new ERC721Wrapper(provider, usedAddresses, owner);

        const numDummyErc20ToDeploy = 3;
        [erc20TokenA, erc20TokenB, zrxToken] = await erc20Wrapper.deployDummyTokensAsync(
            numDummyErc20ToDeploy,
            constants.DUMMY_TOKEN_DECIMALS,
        );
        erc20Proxy = await erc20Wrapper.deployProxyAsync();
        await erc20Wrapper.setBalancesAndAllowancesAsync();

        [erc721Token] = await erc721Wrapper.deployDummyTokensAsync();
        erc721Proxy = await erc721Wrapper.deployProxyAsync();
        await erc721Wrapper.setBalancesAndAllowancesAsync();
        const erc721Balances = await erc721Wrapper.getBalancesAsync();
        erc721MakerAssetId = erc721Balances[makerAddress][erc721Token.address][0];
        erc721TakerAssetId = erc721Balances[takerAddress][erc721Token.address][0];

        exchange = await ExchangeContract.deployFrom0xArtifactAsync(
            artifacts.Exchange,
            provider,
            txDefaults,
            assetProxyUtils.encodeERC20AssetData(zrxToken.address),
        );
        exchangeWrapper = new ExchangeWrapper(exchange, provider);
        await exchangeWrapper.registerAssetProxyAsync(erc20Proxy.address, owner);
        await exchangeWrapper.registerAssetProxyAsync(erc721Proxy.address, owner);

        await web3Wrapper.awaitTransactionSuccessAsync(
            await erc20Proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, {
                from: owner,
            }),
            constants.AWAIT_TRANSACTION_MINED_MS,
        );
        await web3Wrapper.awaitTransactionSuccessAsync(
            await erc721Proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, {
                from: owner,
            }),
            constants.AWAIT_TRANSACTION_MINED_MS,
        );

        defaultMakerAssetAddress = erc20TokenA.address;
        defaultTakerAssetAddress = erc20TokenB.address;

        const defaultOrderParams = {
            ...constants.STATIC_ORDER_PARAMS,
            exchangeAddress: exchange.address,
            makerAddress,
            feeRecipientAddress,
            makerAssetData: assetProxyUtils.encodeERC20AssetData(defaultMakerAssetAddress),
            takerAssetData: assetProxyUtils.encodeERC20AssetData(defaultTakerAssetAddress),
        };
        const privateKey = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
        orderFactory = new OrderFactory(privateKey, defaultOrderParams);
    });
    beforeEach(async () => {
        await blockchainLifecycle.startAsync();
        erc20Balances = await erc20Wrapper.getBalancesAsync();
    });
    afterEach(async () => {
        await blockchainLifecycle.revertAsync();
    });
    describe('fillOrKillOrder', () => {
        it('should transfer the correct amounts', async () => {
            const signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(100), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(200), 18),
            });
            const takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);
            await exchangeWrapper.fillOrKillOrderAsync(signedOrder, takerAddress, {
                takerAssetFillAmount,
            });

            const newBalances = await erc20Wrapper.getBalancesAsync();

            const makerAssetFilledAmount = takerAssetFillAmount
                .times(signedOrder.makerAssetAmount)
                .dividedToIntegerBy(signedOrder.takerAssetAmount);
            const makerFee = signedOrder.makerFee
                .times(makerAssetFilledAmount)
                .dividedToIntegerBy(signedOrder.makerAssetAmount);
            const takerFee = signedOrder.takerFee
                .times(makerAssetFilledAmount)
                .dividedToIntegerBy(signedOrder.makerAssetAmount);
            expect(newBalances[makerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[makerAddress][defaultMakerAssetAddress].minus(makerAssetFilledAmount),
            );
            expect(newBalances[makerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[makerAddress][defaultTakerAssetAddress].add(takerAssetFillAmount),
            );
            expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[makerAddress][zrxToken.address].minus(makerFee),
            );
            expect(newBalances[takerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[takerAddress][defaultTakerAssetAddress].minus(takerAssetFillAmount),
            );
            expect(newBalances[takerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[takerAddress][defaultMakerAssetAddress].add(makerAssetFilledAmount),
            );
            expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[takerAddress][zrxToken.address].minus(takerFee),
            );
            expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[feeRecipientAddress][zrxToken.address].add(makerFee.add(takerFee)),
            );
        });

        it('should throw if a signedOrder is expired', async () => {
            const signedOrder = orderFactory.newSignedOrder({
                expirationTimeSeconds: new BigNumber(Math.floor((Date.now() - 10000) / 1000)),
            });

            return expectTransactionFailedAsync(
                exchangeWrapper.fillOrKillOrderAsync(signedOrder, takerAddress),
                RevertReason.OrderUnfillable,
            );
        });

        it('should throw if entire takerAssetFillAmount not filled', async () => {
            const signedOrder = orderFactory.newSignedOrder();

            await exchangeWrapper.fillOrderAsync(signedOrder, takerAddress, {
                takerAssetFillAmount: signedOrder.takerAssetAmount.div(2),
            });

            return expectTransactionFailedAsync(
                exchangeWrapper.fillOrKillOrderAsync(signedOrder, takerAddress),
                RevertReason.CompleteFillFailed,
            );
        });
    });

    describe('fillOrderNoThrow', () => {
        it('should transfer the correct amounts', async () => {
            const signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(100), 18),
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(200), 18),
            });
            const takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);

            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress, {
                takerAssetFillAmount,
                // HACK(albrow): We need to hardcode the gas estimate here because
                // the Geth gas estimator doesn't work with the way we use
                // delegatecall and swallow errors.
                gas: 250000,
            });

            const newBalances = await erc20Wrapper.getBalancesAsync();
            const makerAssetFilledAmount = takerAssetFillAmount
                .times(signedOrder.makerAssetAmount)
                .dividedToIntegerBy(signedOrder.takerAssetAmount);
            const makerFee = signedOrder.makerFee
                .times(makerAssetFilledAmount)
                .dividedToIntegerBy(signedOrder.makerAssetAmount);
            const takerFee = signedOrder.takerFee
                .times(makerAssetFilledAmount)
                .dividedToIntegerBy(signedOrder.makerAssetAmount);

            expect(newBalances[makerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[makerAddress][defaultMakerAssetAddress].minus(makerAssetFilledAmount),
            );
            expect(newBalances[makerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[makerAddress][defaultTakerAssetAddress].add(takerAssetFillAmount),
            );
            expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[makerAddress][zrxToken.address].minus(makerFee),
            );
            expect(newBalances[takerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[takerAddress][defaultTakerAssetAddress].minus(takerAssetFillAmount),
            );
            expect(newBalances[takerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                erc20Balances[takerAddress][defaultMakerAssetAddress].add(makerAssetFilledAmount),
            );
            expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[takerAddress][zrxToken.address].minus(takerFee),
            );
            expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                erc20Balances[feeRecipientAddress][zrxToken.address].add(makerFee.add(takerFee)),
            );
        });

        it('should not change erc20Balances if maker erc20Balances are too low to fill order', async () => {
            const signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18),
            });

            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should not change erc20Balances if taker erc20Balances are too low to fill order', async () => {
            const signedOrder = orderFactory.newSignedOrder({
                takerAssetAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18),
            });

            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should not change erc20Balances if maker allowances are too low to fill order', async () => {
            const signedOrder = orderFactory.newSignedOrder();
            await web3Wrapper.awaitTransactionSuccessAsync(
                await erc20TokenA.approve.sendTransactionAsync(erc20Proxy.address, new BigNumber(0), {
                    from: makerAddress,
                }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );
            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            await web3Wrapper.awaitTransactionSuccessAsync(
                await erc20TokenA.approve.sendTransactionAsync(erc20Proxy.address, constants.INITIAL_ERC20_ALLOWANCE, {
                    from: makerAddress,
                }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );

            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should not change erc20Balances if taker allowances are too low to fill order', async () => {
            const signedOrder = orderFactory.newSignedOrder();
            await web3Wrapper.awaitTransactionSuccessAsync(
                await erc20TokenB.approve.sendTransactionAsync(erc20Proxy.address, new BigNumber(0), {
                    from: takerAddress,
                }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );
            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            await web3Wrapper.awaitTransactionSuccessAsync(
                await erc20TokenB.approve.sendTransactionAsync(erc20Proxy.address, constants.INITIAL_ERC20_ALLOWANCE, {
                    from: takerAddress,
                }),
                constants.AWAIT_TRANSACTION_MINED_MS,
            );

            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should not change erc20Balances if makerAssetAddress is ZRX, makerAssetAmount + makerFee > maker balance', async () => {
            const makerZRXBalance = new BigNumber(erc20Balances[makerAddress][zrxToken.address]);
            const signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: makerZRXBalance,
                makerFee: new BigNumber(1),
                makerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
            });
            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should not change erc20Balances if makerAssetAddress is ZRX, makerAssetAmount + makerFee > maker allowance', async () => {
            const makerZRXAllowance = await zrxToken.allowance.callAsync(makerAddress, erc20Proxy.address);
            const signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: new BigNumber(makerZRXAllowance),
                makerFee: new BigNumber(1),
                makerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
            });
            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should not change erc20Balances if takerAssetAddress is ZRX, takerAssetAmount + takerFee > taker balance', async () => {
            const takerZRXBalance = new BigNumber(erc20Balances[takerAddress][zrxToken.address]);
            const signedOrder = orderFactory.newSignedOrder({
                takerAssetAmount: takerZRXBalance,
                takerFee: new BigNumber(1),
                takerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
            });
            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should not change erc20Balances if takerAssetAddress is ZRX, takerAssetAmount + takerFee > taker allowance', async () => {
            const takerZRXAllowance = await zrxToken.allowance.callAsync(takerAddress, erc20Proxy.address);
            const signedOrder = orderFactory.newSignedOrder({
                takerAssetAmount: new BigNumber(takerZRXAllowance),
                takerFee: new BigNumber(1),
                takerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
            });
            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress);
            const newBalances = await erc20Wrapper.getBalancesAsync();
            expect(newBalances).to.be.deep.equal(erc20Balances);
        });

        it('should successfully exchange ERC721 tokens', async () => {
            // Construct Exchange parameters
            const makerAssetId = erc721MakerAssetId;
            const takerAssetId = erc721TakerAssetId;
            const signedOrder = orderFactory.newSignedOrder({
                makerAssetAmount: new BigNumber(1),
                takerAssetAmount: new BigNumber(1),
                makerAssetData: assetProxyUtils.encodeERC721AssetData(erc721Token.address, makerAssetId),
                takerAssetData: assetProxyUtils.encodeERC721AssetData(erc721Token.address, takerAssetId),
            });
            // Verify pre-conditions
            const initialOwnerMakerAsset = await erc721Token.ownerOf.callAsync(makerAssetId);
            expect(initialOwnerMakerAsset).to.be.bignumber.equal(makerAddress);
            const initialOwnerTakerAsset = await erc721Token.ownerOf.callAsync(takerAssetId);
            expect(initialOwnerTakerAsset).to.be.bignumber.equal(takerAddress);
            // Call Exchange
            const takerAssetFillAmount = signedOrder.takerAssetAmount;
            await exchangeWrapper.fillOrderNoThrowAsync(signedOrder, takerAddress, {
                takerAssetFillAmount,
                // HACK(albrow): We need to hardcode the gas estimate here because
                // the Geth gas estimator doesn't work with the way we use
                // delegatecall and swallow errors.
                gas: 280000,
            });
            // Verify post-conditions
            const newOwnerMakerAsset = await erc721Token.ownerOf.callAsync(makerAssetId);
            expect(newOwnerMakerAsset).to.be.bignumber.equal(takerAddress);
            const newOwnerTakerAsset = await erc721Token.ownerOf.callAsync(takerAssetId);
            expect(newOwnerTakerAsset).to.be.bignumber.equal(makerAddress);
        });
    });

    describe('batch functions', () => {
        let signedOrders: SignedOrder[];
        beforeEach(async () => {
            signedOrders = [
                orderFactory.newSignedOrder(),
                orderFactory.newSignedOrder(),
                orderFactory.newSignedOrder(),
            ];
        });

        describe('batchFillOrders', () => {
            it('should transfer the correct amounts', async () => {
                const takerAssetFillAmounts: BigNumber[] = [];
                const makerAssetAddress = erc20TokenA.address;
                const takerAssetAddress = erc20TokenB.address;
                _.forEach(signedOrders, signedOrder => {
                    const takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);
                    const makerAssetFilledAmount = takerAssetFillAmount
                        .times(signedOrder.makerAssetAmount)
                        .dividedToIntegerBy(signedOrder.takerAssetAmount);
                    const makerFee = signedOrder.makerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    const takerFee = signedOrder.takerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    takerAssetFillAmounts.push(takerAssetFillAmount);
                    erc20Balances[makerAddress][makerAssetAddress] = erc20Balances[makerAddress][
                        makerAssetAddress
                    ].minus(makerAssetFilledAmount);
                    erc20Balances[makerAddress][takerAssetAddress] = erc20Balances[makerAddress][takerAssetAddress].add(
                        takerAssetFillAmount,
                    );
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        makerFee,
                    );
                    erc20Balances[takerAddress][makerAssetAddress] = erc20Balances[takerAddress][makerAssetAddress].add(
                        makerAssetFilledAmount,
                    );
                    erc20Balances[takerAddress][takerAssetAddress] = erc20Balances[takerAddress][
                        takerAssetAddress
                    ].minus(takerAssetFillAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(makerFee.add(takerFee));
                });

                await exchangeWrapper.batchFillOrdersAsync(signedOrders, takerAddress, {
                    takerAssetFillAmounts,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });
        });

        describe('batchFillOrKillOrders', () => {
            it('should transfer the correct amounts', async () => {
                const takerAssetFillAmounts: BigNumber[] = [];
                const makerAssetAddress = erc20TokenA.address;
                const takerAssetAddress = erc20TokenB.address;
                _.forEach(signedOrders, signedOrder => {
                    const takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);
                    const makerAssetFilledAmount = takerAssetFillAmount
                        .times(signedOrder.makerAssetAmount)
                        .dividedToIntegerBy(signedOrder.takerAssetAmount);
                    const makerFee = signedOrder.makerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    const takerFee = signedOrder.takerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    takerAssetFillAmounts.push(takerAssetFillAmount);
                    erc20Balances[makerAddress][makerAssetAddress] = erc20Balances[makerAddress][
                        makerAssetAddress
                    ].minus(makerAssetFilledAmount);
                    erc20Balances[makerAddress][takerAssetAddress] = erc20Balances[makerAddress][takerAssetAddress].add(
                        takerAssetFillAmount,
                    );
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        makerFee,
                    );
                    erc20Balances[takerAddress][makerAssetAddress] = erc20Balances[takerAddress][makerAssetAddress].add(
                        makerAssetFilledAmount,
                    );
                    erc20Balances[takerAddress][takerAssetAddress] = erc20Balances[takerAddress][
                        takerAssetAddress
                    ].minus(takerAssetFillAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(makerFee.add(takerFee));
                });

                await exchangeWrapper.batchFillOrKillOrdersAsync(signedOrders, takerAddress, {
                    takerAssetFillAmounts,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });

            it('should throw if a single signedOrder does not fill the expected amount', async () => {
                const takerAssetFillAmounts: BigNumber[] = [];
                _.forEach(signedOrders, signedOrder => {
                    const takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);
                    takerAssetFillAmounts.push(takerAssetFillAmount);
                });

                await exchangeWrapper.fillOrKillOrderAsync(signedOrders[0], takerAddress);

                return expectTransactionFailedAsync(
                    exchangeWrapper.batchFillOrKillOrdersAsync(signedOrders, takerAddress, {
                        takerAssetFillAmounts,
                    }),
                    RevertReason.OrderUnfillable,
                );
            });
        });

        describe('batchFillOrdersNoThrow', async () => {
            it('should transfer the correct amounts', async () => {
                const takerAssetFillAmounts: BigNumber[] = [];
                const makerAssetAddress = erc20TokenA.address;
                const takerAssetAddress = erc20TokenB.address;
                _.forEach(signedOrders, signedOrder => {
                    const takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);
                    const makerAssetFilledAmount = takerAssetFillAmount
                        .times(signedOrder.makerAssetAmount)
                        .dividedToIntegerBy(signedOrder.takerAssetAmount);
                    const makerFee = signedOrder.makerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    const takerFee = signedOrder.takerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    takerAssetFillAmounts.push(takerAssetFillAmount);
                    erc20Balances[makerAddress][makerAssetAddress] = erc20Balances[makerAddress][
                        makerAssetAddress
                    ].minus(makerAssetFilledAmount);
                    erc20Balances[makerAddress][takerAssetAddress] = erc20Balances[makerAddress][takerAssetAddress].add(
                        takerAssetFillAmount,
                    );
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        makerFee,
                    );
                    erc20Balances[takerAddress][makerAssetAddress] = erc20Balances[takerAddress][makerAssetAddress].add(
                        makerAssetFilledAmount,
                    );
                    erc20Balances[takerAddress][takerAssetAddress] = erc20Balances[takerAddress][
                        takerAssetAddress
                    ].minus(takerAssetFillAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(makerFee.add(takerFee));
                });

                await exchangeWrapper.batchFillOrdersNoThrowAsync(signedOrders, takerAddress, {
                    takerAssetFillAmounts,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 600000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });

            it('should not throw if an order is invalid and fill the remaining orders', async () => {
                const takerAssetFillAmounts: BigNumber[] = [];
                const makerAssetAddress = erc20TokenA.address;
                const takerAssetAddress = erc20TokenB.address;

                const invalidOrder = {
                    ...signedOrders[0],
                    signature: '0x00',
                };
                const validOrders = signedOrders.slice(1);

                takerAssetFillAmounts.push(invalidOrder.takerAssetAmount.div(2));
                _.forEach(validOrders, signedOrder => {
                    const takerAssetFillAmount = signedOrder.takerAssetAmount.div(2);
                    const makerAssetFilledAmount = takerAssetFillAmount
                        .times(signedOrder.makerAssetAmount)
                        .dividedToIntegerBy(signedOrder.takerAssetAmount);
                    const makerFee = signedOrder.makerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    const takerFee = signedOrder.takerFee
                        .times(makerAssetFilledAmount)
                        .dividedToIntegerBy(signedOrder.makerAssetAmount);
                    takerAssetFillAmounts.push(takerAssetFillAmount);
                    erc20Balances[makerAddress][makerAssetAddress] = erc20Balances[makerAddress][
                        makerAssetAddress
                    ].minus(makerAssetFilledAmount);
                    erc20Balances[makerAddress][takerAssetAddress] = erc20Balances[makerAddress][takerAssetAddress].add(
                        takerAssetFillAmount,
                    );
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        makerFee,
                    );
                    erc20Balances[takerAddress][makerAssetAddress] = erc20Balances[takerAddress][makerAssetAddress].add(
                        makerAssetFilledAmount,
                    );
                    erc20Balances[takerAddress][takerAssetAddress] = erc20Balances[takerAddress][
                        takerAssetAddress
                    ].minus(takerAssetFillAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(makerFee.add(takerFee));
                });

                const newOrders = [invalidOrder, ...validOrders];
                await exchangeWrapper.batchFillOrdersNoThrowAsync(newOrders, takerAddress, {
                    takerAssetFillAmounts,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 450000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });
        });

        describe('marketSellOrders', () => {
            it('should stop when the entire takerAssetFillAmount is filled', async () => {
                const takerAssetFillAmount = signedOrders[0].takerAssetAmount.plus(
                    signedOrders[1].takerAssetAmount.div(2),
                );
                await exchangeWrapper.marketSellOrdersAsync(signedOrders, takerAddress, {
                    takerAssetFillAmount,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();

                const makerAssetFilledAmount = signedOrders[0].makerAssetAmount.add(
                    signedOrders[1].makerAssetAmount.dividedToIntegerBy(2),
                );
                const makerFee = signedOrders[0].makerFee.add(signedOrders[1].makerFee.dividedToIntegerBy(2));
                const takerFee = signedOrders[0].takerFee.add(signedOrders[1].takerFee.dividedToIntegerBy(2));
                expect(newBalances[makerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultMakerAssetAddress].minus(makerAssetFilledAmount),
                );
                expect(newBalances[makerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultTakerAssetAddress].add(takerAssetFillAmount),
                );
                expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][zrxToken.address].minus(makerFee),
                );
                expect(newBalances[takerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultTakerAssetAddress].minus(takerAssetFillAmount),
                );
                expect(newBalances[takerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultMakerAssetAddress].add(makerAssetFilledAmount),
                );
                expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][zrxToken.address].minus(takerFee),
                );
                expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[feeRecipientAddress][zrxToken.address].add(makerFee.add(takerFee)),
                );
            });

            it('should fill all signedOrders if cannot fill entire takerAssetFillAmount', async () => {
                const takerAssetFillAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18);
                _.forEach(signedOrders, signedOrder => {
                    erc20Balances[makerAddress][defaultMakerAssetAddress] = erc20Balances[makerAddress][
                        defaultMakerAssetAddress
                    ].minus(signedOrder.makerAssetAmount);
                    erc20Balances[makerAddress][defaultTakerAssetAddress] = erc20Balances[makerAddress][
                        defaultTakerAssetAddress
                    ].add(signedOrder.takerAssetAmount);
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        signedOrder.makerFee,
                    );
                    erc20Balances[takerAddress][defaultMakerAssetAddress] = erc20Balances[takerAddress][
                        defaultMakerAssetAddress
                    ].add(signedOrder.makerAssetAmount);
                    erc20Balances[takerAddress][defaultTakerAssetAddress] = erc20Balances[takerAddress][
                        defaultTakerAssetAddress
                    ].minus(signedOrder.takerAssetAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        signedOrder.takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(signedOrder.makerFee.add(signedOrder.takerFee));
                });
                await exchangeWrapper.marketSellOrdersAsync(signedOrders, takerAddress, {
                    takerAssetFillAmount,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });

            it('should throw when a signedOrder does not use the same takerAssetAddress', async () => {
                signedOrders = [
                    orderFactory.newSignedOrder(),
                    orderFactory.newSignedOrder({
                        takerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
                    }),
                    orderFactory.newSignedOrder(),
                ];

                return expectTransactionFailedAsync(
                    exchangeWrapper.marketSellOrdersAsync(signedOrders, takerAddress, {
                        takerAssetFillAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(1000), 18),
                    }),
                    // We simply use the takerAssetData from the first order for all orders.
                    // If they are not the same, the contract throws when validating the order signature
                    RevertReason.InvalidOrderSignature,
                );
            });
        });

        describe('marketSellOrdersNoThrow', () => {
            it('should stop when the entire takerAssetFillAmount is filled', async () => {
                const takerAssetFillAmount = signedOrders[0].takerAssetAmount.plus(
                    signedOrders[1].takerAssetAmount.div(2),
                );
                await exchangeWrapper.marketSellOrdersNoThrowAsync(signedOrders, takerAddress, {
                    takerAssetFillAmount,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 6000000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();

                const makerAssetFilledAmount = signedOrders[0].makerAssetAmount.add(
                    signedOrders[1].makerAssetAmount.dividedToIntegerBy(2),
                );
                const makerFee = signedOrders[0].makerFee.add(signedOrders[1].makerFee.dividedToIntegerBy(2));
                const takerFee = signedOrders[0].takerFee.add(signedOrders[1].takerFee.dividedToIntegerBy(2));
                expect(newBalances[makerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultMakerAssetAddress].minus(makerAssetFilledAmount),
                );
                expect(newBalances[makerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultTakerAssetAddress].add(takerAssetFillAmount),
                );
                expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][zrxToken.address].minus(makerFee),
                );
                expect(newBalances[takerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultTakerAssetAddress].minus(takerAssetFillAmount),
                );
                expect(newBalances[takerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultMakerAssetAddress].add(makerAssetFilledAmount),
                );
                expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][zrxToken.address].minus(takerFee),
                );
                expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[feeRecipientAddress][zrxToken.address].add(makerFee.add(takerFee)),
                );
            });

            it('should fill all signedOrders if cannot fill entire takerAssetFillAmount', async () => {
                const takerAssetFillAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18);
                _.forEach(signedOrders, signedOrder => {
                    erc20Balances[makerAddress][defaultMakerAssetAddress] = erc20Balances[makerAddress][
                        defaultMakerAssetAddress
                    ].minus(signedOrder.makerAssetAmount);
                    erc20Balances[makerAddress][defaultTakerAssetAddress] = erc20Balances[makerAddress][
                        defaultTakerAssetAddress
                    ].add(signedOrder.takerAssetAmount);
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        signedOrder.makerFee,
                    );
                    erc20Balances[takerAddress][defaultMakerAssetAddress] = erc20Balances[takerAddress][
                        defaultMakerAssetAddress
                    ].add(signedOrder.makerAssetAmount);
                    erc20Balances[takerAddress][defaultTakerAssetAddress] = erc20Balances[takerAddress][
                        defaultTakerAssetAddress
                    ].minus(signedOrder.takerAssetAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        signedOrder.takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(signedOrder.makerFee.add(signedOrder.takerFee));
                });
                await exchangeWrapper.marketSellOrdersNoThrowAsync(signedOrders, takerAddress, {
                    takerAssetFillAmount,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 600000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });

            it('should not fill a signedOrder that does not use the same takerAssetAddress', async () => {
                signedOrders = [
                    orderFactory.newSignedOrder(),
                    orderFactory.newSignedOrder(),
                    orderFactory.newSignedOrder({
                        takerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
                    }),
                ];
                const takerAssetFillAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18);
                const filledSignedOrders = signedOrders.slice(0, -1);
                _.forEach(filledSignedOrders, signedOrder => {
                    erc20Balances[makerAddress][defaultMakerAssetAddress] = erc20Balances[makerAddress][
                        defaultMakerAssetAddress
                    ].minus(signedOrder.makerAssetAmount);
                    erc20Balances[makerAddress][defaultTakerAssetAddress] = erc20Balances[makerAddress][
                        defaultTakerAssetAddress
                    ].add(signedOrder.takerAssetAmount);
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        signedOrder.makerFee,
                    );
                    erc20Balances[takerAddress][defaultMakerAssetAddress] = erc20Balances[takerAddress][
                        defaultMakerAssetAddress
                    ].add(signedOrder.makerAssetAmount);
                    erc20Balances[takerAddress][defaultTakerAssetAddress] = erc20Balances[takerAddress][
                        defaultTakerAssetAddress
                    ].minus(signedOrder.takerAssetAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        signedOrder.takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(signedOrder.makerFee.add(signedOrder.takerFee));
                });
                await exchangeWrapper.marketSellOrdersNoThrowAsync(signedOrders, takerAddress, {
                    takerAssetFillAmount,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 600000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });
        });

        describe('marketBuyOrders', () => {
            it('should stop when the entire makerAssetFillAmount is filled', async () => {
                const makerAssetFillAmount = signedOrders[0].makerAssetAmount.plus(
                    signedOrders[1].makerAssetAmount.div(2),
                );
                await exchangeWrapper.marketBuyOrdersAsync(signedOrders, takerAddress, {
                    makerAssetFillAmount,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();

                const makerAmountBought = signedOrders[0].takerAssetAmount.add(
                    signedOrders[1].takerAssetAmount.dividedToIntegerBy(2),
                );
                const makerFee = signedOrders[0].makerFee.add(signedOrders[1].makerFee.dividedToIntegerBy(2));
                const takerFee = signedOrders[0].takerFee.add(signedOrders[1].takerFee.dividedToIntegerBy(2));
                expect(newBalances[makerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultMakerAssetAddress].minus(makerAssetFillAmount),
                );
                expect(newBalances[makerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultTakerAssetAddress].add(makerAmountBought),
                );
                expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][zrxToken.address].minus(makerFee),
                );
                expect(newBalances[takerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultTakerAssetAddress].minus(makerAmountBought),
                );
                expect(newBalances[takerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultMakerAssetAddress].add(makerAssetFillAmount),
                );
                expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][zrxToken.address].minus(takerFee),
                );
                expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[feeRecipientAddress][zrxToken.address].add(makerFee.add(takerFee)),
                );
            });

            it('should fill all signedOrders if cannot fill entire makerAssetFillAmount', async () => {
                const makerAssetFillAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18);
                _.forEach(signedOrders, signedOrder => {
                    erc20Balances[makerAddress][defaultMakerAssetAddress] = erc20Balances[makerAddress][
                        defaultMakerAssetAddress
                    ].minus(signedOrder.makerAssetAmount);
                    erc20Balances[makerAddress][defaultTakerAssetAddress] = erc20Balances[makerAddress][
                        defaultTakerAssetAddress
                    ].add(signedOrder.takerAssetAmount);
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        signedOrder.makerFee,
                    );
                    erc20Balances[takerAddress][defaultMakerAssetAddress] = erc20Balances[takerAddress][
                        defaultMakerAssetAddress
                    ].add(signedOrder.makerAssetAmount);
                    erc20Balances[takerAddress][defaultTakerAssetAddress] = erc20Balances[takerAddress][
                        defaultTakerAssetAddress
                    ].minus(signedOrder.takerAssetAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        signedOrder.takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(signedOrder.makerFee.add(signedOrder.takerFee));
                });
                await exchangeWrapper.marketBuyOrdersAsync(signedOrders, takerAddress, {
                    makerAssetFillAmount,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });

            it('should throw when a signedOrder does not use the same makerAssetAddress', async () => {
                signedOrders = [
                    orderFactory.newSignedOrder(),
                    orderFactory.newSignedOrder({
                        makerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
                    }),
                    orderFactory.newSignedOrder(),
                ];

                return expectTransactionFailedAsync(
                    exchangeWrapper.marketBuyOrdersAsync(signedOrders, takerAddress, {
                        makerAssetFillAmount: Web3Wrapper.toBaseUnitAmount(new BigNumber(1000), 18),
                    }),
                    RevertReason.InvalidOrderSignature,
                );
            });
        });

        describe('marketBuyOrdersNoThrow', () => {
            it('should stop when the entire makerAssetFillAmount is filled', async () => {
                const makerAssetFillAmount = signedOrders[0].makerAssetAmount.plus(
                    signedOrders[1].makerAssetAmount.div(2),
                );
                await exchangeWrapper.marketBuyOrdersNoThrowAsync(signedOrders, takerAddress, {
                    makerAssetFillAmount,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 600000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();

                const makerAmountBought = signedOrders[0].takerAssetAmount.add(
                    signedOrders[1].takerAssetAmount.dividedToIntegerBy(2),
                );
                const makerFee = signedOrders[0].makerFee.add(signedOrders[1].makerFee.dividedToIntegerBy(2));
                const takerFee = signedOrders[0].takerFee.add(signedOrders[1].takerFee.dividedToIntegerBy(2));
                expect(newBalances[makerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultMakerAssetAddress].minus(makerAssetFillAmount),
                );
                expect(newBalances[makerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][defaultTakerAssetAddress].add(makerAmountBought),
                );
                expect(newBalances[makerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[makerAddress][zrxToken.address].minus(makerFee),
                );
                expect(newBalances[takerAddress][defaultTakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultTakerAssetAddress].minus(makerAmountBought),
                );
                expect(newBalances[takerAddress][defaultMakerAssetAddress]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][defaultMakerAssetAddress].add(makerAssetFillAmount),
                );
                expect(newBalances[takerAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[takerAddress][zrxToken.address].minus(takerFee),
                );
                expect(newBalances[feeRecipientAddress][zrxToken.address]).to.be.bignumber.equal(
                    erc20Balances[feeRecipientAddress][zrxToken.address].add(makerFee.add(takerFee)),
                );
            });

            it('should fill all signedOrders if cannot fill entire makerAssetFillAmount', async () => {
                const makerAssetFillAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18);
                _.forEach(signedOrders, signedOrder => {
                    erc20Balances[makerAddress][defaultMakerAssetAddress] = erc20Balances[makerAddress][
                        defaultMakerAssetAddress
                    ].minus(signedOrder.makerAssetAmount);
                    erc20Balances[makerAddress][defaultTakerAssetAddress] = erc20Balances[makerAddress][
                        defaultTakerAssetAddress
                    ].add(signedOrder.takerAssetAmount);
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        signedOrder.makerFee,
                    );
                    erc20Balances[takerAddress][defaultMakerAssetAddress] = erc20Balances[takerAddress][
                        defaultMakerAssetAddress
                    ].add(signedOrder.makerAssetAmount);
                    erc20Balances[takerAddress][defaultTakerAssetAddress] = erc20Balances[takerAddress][
                        defaultTakerAssetAddress
                    ].minus(signedOrder.takerAssetAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        signedOrder.takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(signedOrder.makerFee.add(signedOrder.takerFee));
                });
                await exchangeWrapper.marketBuyOrdersNoThrowAsync(signedOrders, takerAddress, {
                    makerAssetFillAmount,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 600000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });

            it('should not fill a signedOrder that does not use the same makerAssetAddress', async () => {
                signedOrders = [
                    orderFactory.newSignedOrder(),
                    orderFactory.newSignedOrder(),
                    orderFactory.newSignedOrder({
                        makerAssetData: assetProxyUtils.encodeERC20AssetData(zrxToken.address),
                    }),
                ];

                const makerAssetFillAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(100000), 18);
                const filledSignedOrders = signedOrders.slice(0, -1);
                _.forEach(filledSignedOrders, signedOrder => {
                    erc20Balances[makerAddress][defaultMakerAssetAddress] = erc20Balances[makerAddress][
                        defaultMakerAssetAddress
                    ].minus(signedOrder.makerAssetAmount);
                    erc20Balances[makerAddress][defaultTakerAssetAddress] = erc20Balances[makerAddress][
                        defaultTakerAssetAddress
                    ].add(signedOrder.takerAssetAmount);
                    erc20Balances[makerAddress][zrxToken.address] = erc20Balances[makerAddress][zrxToken.address].minus(
                        signedOrder.makerFee,
                    );
                    erc20Balances[takerAddress][defaultMakerAssetAddress] = erc20Balances[takerAddress][
                        defaultMakerAssetAddress
                    ].add(signedOrder.makerAssetAmount);
                    erc20Balances[takerAddress][defaultTakerAssetAddress] = erc20Balances[takerAddress][
                        defaultTakerAssetAddress
                    ].minus(signedOrder.takerAssetAmount);
                    erc20Balances[takerAddress][zrxToken.address] = erc20Balances[takerAddress][zrxToken.address].minus(
                        signedOrder.takerFee,
                    );
                    erc20Balances[feeRecipientAddress][zrxToken.address] = erc20Balances[feeRecipientAddress][
                        zrxToken.address
                    ].add(signedOrder.makerFee.add(signedOrder.takerFee));
                });
                await exchangeWrapper.marketBuyOrdersNoThrowAsync(signedOrders, takerAddress, {
                    makerAssetFillAmount,
                    // HACK(albrow): We need to hardcode the gas estimate here because
                    // the Geth gas estimator doesn't work with the way we use
                    // delegatecall and swallow errors.
                    gas: 600000,
                });

                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(newBalances).to.be.deep.equal(erc20Balances);
            });
        });

        describe('batchCancelOrders', () => {
            it('should be able to cancel multiple signedOrders', async () => {
                const takerAssetCancelAmounts = _.map(signedOrders, signedOrder => signedOrder.takerAssetAmount);
                await exchangeWrapper.batchCancelOrdersAsync(signedOrders, makerAddress);

                await exchangeWrapper.batchFillOrdersNoThrowAsync(signedOrders, takerAddress, {
                    takerAssetFillAmounts: takerAssetCancelAmounts,
                });
                const newBalances = await erc20Wrapper.getBalancesAsync();
                expect(erc20Balances).to.be.deep.equal(newBalances);
            });
        });
    });
}); // tslint:disable-line:max-file-line-count
