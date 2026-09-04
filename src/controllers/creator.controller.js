const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const CreatorModel = require("../models/creator.model");
const WalletModel = require("../models/wallet.model");
const { generateUssdCode } = require("../utils/generate.ussd.code");

const signupCreator = async (req, res) => {
  try {
      const {
          name,
          email,
          mobileMoneyNumber,
          password,
          bio,
          profilePicture } = req.body;

    if (!name || !email || !mobileMoneyNumber || !password) {
        return res.status(400).json({
            error: "Name, email, mobileMoneyNumber, and password are required" });
    }

    const creatorExist = await CreatorModel.findOne({ email });
    if (creatorExist) {
      return res.status(409).json({ error: "Creator already exists" });
    }

    const hashPassword = await bcrypt.hash(password, 10);
    const ussdCode = generateUssdCode();

    const newCreator = await CreatorModel.create({
      name,
      email,
      mobileMoneyNumber,
      password: hashPassword,
      bio: bio || "",
      profilePicture: profilePicture || "",
      ussdCode,
      totalEarnings: 0,
    });

    await WalletModel.create({
      accountNumber: mobileMoneyNumber,
      accountName: name,
      userId: newCreator._id,
      balance: 0,
    });

    return res.status(201).json({
      id: newCreator._id,
      ussdCode,
      message: "Creator created successfully",
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const loginCreator = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const creator = await CreatorModel.findOne({ email });
    if (!creator) {
      return res.status(404).json({ error: "Creator does not exist" });
    }

    const validPassword = await bcrypt.compare(password, creator.password);
    if (!validPassword) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const payload = { id: creator._id, email: creator.email, name: creator.name };
    const accessToken = jwt.sign(payload, process.env.JWT_KEY, { expiresIn: "3d" });

    return res.status(200).json({ accessToken, message: "Login successful" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const getCreatorProfile = async (req, res) => {
  try {
    const theCreator = await CreatorModel.findById(req.user.id).select("-password -pin");
    if (!theCreator) {
      return res.status(404).json({ error: "Creator not found" });
    }
    return res.status(200).json(theCreator);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const setPin = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin.length < 4) {
      return res.status(400).json({ error: "Valid 4-digit PIN required" });
    }

    const creator = await CreatorModel.findById(req.user.id);
    if (!creator) {
      return res.status(404).json({ error: "Creator not found" });
    }

    creator.pin = await bcrypt.hash(pin.toString(), 10);
    await creator.save();

    return res.status(200).json({ message: "PIN set successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: "Old and new password required" });
    }

    const creator = await CreatorModel.findById(req.user.id);
    if (!creator) {
      return res.status(404).json({ error: "Creator not found" });
    }

    const validOld = await bcrypt.compare(oldPassword, creator.password);
    if (!validOld) {
      return res.status(400).json({ error: "Invalid old password" });
    }

    creator.password = await bcrypt.hash(newPassword, 10);
    await creator.save();

    return res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  signupCreator,
  loginCreator,
  getCreatorProfile,
  setPin,
  changePassword,
};