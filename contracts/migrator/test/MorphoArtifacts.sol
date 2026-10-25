// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.19;

// Compiles the real Morpho Blue (exact pragma 0.8.19) and its test mocks so the 0.8.28 tests can
// deployCode() them. Nothing here is Q41 code.
import {Morpho} from "morpho-blue/Morpho.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {OracleMock} from "morpho-blue/mocks/OracleMock.sol";
